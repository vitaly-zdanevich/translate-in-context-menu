import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { LANGUAGES, languageName, normalizeTargetLanguage } from '../src/languages.js';

const url = new URL('../src/language-options.js', import.meta.url);
const source = readFileSync(url, 'utf8');
const imports = "import { LANGUAGES, normalizeTargetLanguage } from './languages.js';";
assert.ok(source.startsWith(imports));

/** Run the production dropdown with a minimal DOM and isolated local storage. */
function setup(saved = {}, overrides = {}) {
	const data = { ...saved };
	const writes = [];
	const reads = [];
	const status = { textContent: '' };
	let listener;
	const select = {
		value: '', disabled: true, options: [],
		replaceChildren(...options) { this.options = options; },
		addEventListener(name, callback) { assert.equal(name, 'change'); listener = callback; },
	};
	const storage = {
		get: async key => { reads.push(key); return { ...data }; },
		set: async value => { writes.push({ ...value }); Object.assign(data, value); },
		...overrides,
	};
	const ready = vm.runInNewContext(source.slice(imports.length), {
		LANGUAGES, normalizeTargetLanguage,
		Option: function Option(text, value) { this.text = text; this.value = value; },
		document: { querySelector: selector => selector === '#target-language' ? select : status },
		browser: { storage: { local: storage } },
		fetch: () => assert.fail('Choosing a language must not contact Google'),
	}, { filename: url.pathname });
	return { ready, data, writes, reads, select, status, storage, change: value => { select.value = value; return listener(); } };
}

test('the bundled catalog includes NMT languages and regional/script targets with English names', () => {
	for (const [code, name] of [['ru', 'Russian'], ['fr', 'French'], ['ka', 'Georgian'],
		['zh-TW', 'Chinese (Traditional)'], ['mni-Mtei', 'Meiteilon (Manipuri)'], ['pa-Arab', 'Punjabi (Shahmukhi)']]) {
		assert.equal(LANGUAGES.get(code), name);
	}
	assert.ok(LANGUAGES.size > 190);
});

test('target normalization supports documented aliases, casing, and missing preferences', () => {
	for (const value of [undefined, null, {}, 7, '', 'unknown']) assert.equal(normalizeTargetLanguage(value), 'ru');
	for (const [value, expected] of [[' FR ', 'fr'], ['zh-tw', 'zh-TW'], ['zh', 'zh-CN'],
		['iw', 'he'], ['jw', 'jv'], ['tl', 'fil']]) assert.equal(normalizeTargetLanguage(value), expected);
	assert.equal(languageName('de'), 'German');
	assert.equal(languageName(undefined), 'Russian');
});

test('the dropdown defaults to Russian, offers all targets, and makes no storage write or API request', async () => {
	const app = setup();
	assert.equal(app.select.disabled, true);
	await app.ready;
	assert.equal(app.select.value, 'ru');
	assert.equal(app.select.disabled, false);
	assert.equal(app.select.options.length, LANGUAGES.size);
	assert.equal(app.select.options.find(option => option.value === 'ru').text, 'Russian');
	assert.deepEqual(app.reads, ['targetLanguage']);
	assert.deepEqual(app.writes, []);
});

test('saved languages are restored and invalid saved values fall back to Russian', async () => {
	for (const [saved, expected] of [['fr', 'fr'], ['zh-TW', 'zh-TW'], [null, 'ru'], ['xx', 'ru']]) {
		const app = setup({ targetLanguage: saved });
		await app.ready;
		assert.equal(app.select.value, expected);
		assert.deepEqual(app.writes, []);
	}
});

test('choosing a target saves only that preference and preserves API key and pairing', async () => {
	const app = setup({ apiKey: 'secret', phoneToken: 'pairing', targetLanguage: 'ru' });
	await app.ready;
	const pending = app.change('fr');
	assert.equal(app.select.disabled, true);
	await pending;
	assert.deepEqual(app.writes, [{ targetLanguage: 'fr' }]);
	assert.deepEqual(app.data, { apiKey: 'secret', phoneToken: 'pairing', targetLanguage: 'fr' });
	assert.equal(app.status.textContent, 'Target language saved.');
	assert.equal(app.select.disabled, false);
});

test('a failed save restores the persisted language, reports an English error, and allows retry', async context => {
	const app = setup({ targetLanguage: 'de' });
	await app.ready;
	const failing = context.mock.method(app.storage, 'set', async () => { throw new Error('private storage details'); });
	await app.change('fr');
	assert.equal(app.select.value, 'de');
	assert.equal(app.data.targetLanguage, 'de');
	assert.equal(app.status.textContent, 'Could not save the target language. Please try again.');
	assert.equal(app.select.disabled, false);
	failing.mock.restore();
	await app.change('fr');
	assert.equal(app.data.targetLanguage, 'fr');
});

test('a failed load leaves the dropdown usable without exposing storage errors', async () => {
	const app = setup({}, { get: async () => { throw new Error('private storage details'); } });
	await app.ready;
	assert.equal(app.select.value, 'ru');
	assert.equal(app.select.disabled, false);
	assert.equal(app.status.textContent, 'Could not load the target language. Try reopening Preferences.');
	await app.change('ar');
	assert.equal(app.data.targetLanguage, 'ar');
});
