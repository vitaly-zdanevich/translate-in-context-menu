import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const optionsUrl = new URL('../src/options.js', import.meta.url);
const optionsSource = readFileSync(optionsUrl, 'utf8');

/** Create just the DOM behavior used by the preferences form. */
function element() {
	const listeners = new Map();
	return {
		value: '',
		textContent: '',
		disabled: false,
		focused: false,
		focus() { this.focused = true; },
		addEventListener: (name, listener) => listeners.set(name, listener),
		fire: (name, event) => listeners.get(name)(event),
	};
}

/** Run the real preferences script with isolated local storage and minimal DOM. */
function setup(saved = {}, overrides = {}) {
	const data = { ...saved };
	const calls = { reads: [], writes: [], removals: [], fetches: 0 };
	const elements = Object.fromEntries(
		['settings', 'controls', 'api-key', 'remove-key', 'status'].map(id => [id, element()]),
	);
	elements.controls.disabled = true;
	const storage = {
		get: async key => { calls.reads.push(key); return { ...data }; },
		set: async values => { calls.writes.push({ ...values }); Object.assign(data, values); },
		remove: async key => { calls.removals.push(key); delete data[key]; },
		...overrides,
	};
	const ready = vm.runInNewContext(optionsSource, {
		document: { querySelector: selector => elements[selector.slice(1)] },
		browser: { storage: { local: storage } },
		fetch: () => { calls.fetches++; throw new Error('Preferences must not make requests'); },
	}, { filename: optionsUrl.pathname });

	return {
		ready, data, calls, storage,
		input: elements['api-key'],
		controls: elements.controls,
		status: elements.status,
		submit: () => {
			let prevented = false;
			const result = elements.settings.fire('submit', {
				preventDefault: () => { prevented = true; },
			});
			assert.ok(prevented, 'saving must prevent navigation or form submission');
			return result;
		},
		remove: () => elements['remove-key'].fire('click'),
	};
}

test('preferences load the saved key without changing storage or contacting Google', async () => {
	const app = setup({ apiKey: 'saved-key' });
	assert.equal(app.controls.disabled, true);
	await app.ready;
	assert.equal(app.input.value, 'saved-key');
	assert.equal(app.controls.disabled, false);
	assert.deepEqual(app.calls, { reads: ['apiKey'], writes: [], removals: [], fetches: 0 });
});

test('missing or malformed saved keys leave an empty editable input', async () => {
	for (const saved of [{}, { apiKey: null }, { apiKey: 42 }]) {
		const app = setup(saved);
		await app.ready;
		assert.equal(app.input.value, '');
		assert.equal(app.controls.disabled, false);
	}
});

test('saving trims a key and makes no verification request', async () => {
	const app = setup();
	await app.ready;
	app.input.value = ' \tnew-key\n ';
	const saving = app.submit();
	assert.equal(app.controls.disabled, true);
	await saving;
	assert.equal(app.data.apiKey, 'new-key');
	assert.equal(app.input.value, 'new-key');
	assert.equal(app.status.textContent, 'API key saved.');
	assert.equal(app.controls.disabled, false);
	assert.deepEqual(app.calls.writes, [{ apiKey: 'new-key' }]);
	assert.equal(app.calls.fetches, 0);
});

test('saving a blank key preserves the existing key and requests explicit removal', async () => {
	const app = setup({ apiKey: 'saved-key' });
	await app.ready;
	app.input.value = ' \n\t ';
	await app.submit();
	assert.equal(app.data.apiKey, 'saved-key');
	assert.equal(app.calls.writes.length, 0);
	assert.equal(app.calls.removals.length, 0);
	assert.match(app.status.textContent, /Enter an API key.*Remove key/);
	assert.equal(app.input.focused, true);
	assert.equal(app.controls.disabled, false);
});

test('removing a key deletes only that preference and clears its display', async () => {
	const app = setup({ apiKey: 'saved-key', unrelated: 'keep' });
	await app.ready;
	const removing = app.remove();
	assert.equal(app.controls.disabled, true);
	await removing;
	assert.deepEqual(app.data, { unrelated: 'keep' });
	assert.deepEqual(app.calls.removals, ['apiKey']);
	assert.equal(app.input.value, '');
	assert.equal(app.status.textContent, 'API key removed.');
	assert.equal(app.controls.disabled, false);
	assert.equal(app.calls.fetches, 0);
});

test('a storage read error leaves controls usable and keeps private error details out of status', async () => {
	const app = setup({}, { get: async () => { throw new Error('secret-key read failure'); } });
	await app.ready;
	assert.match(app.status.textContent, /Could not load the saved key/);
	assert.ok(!app.status.textContent.includes('secret-key'));
	assert.equal(app.controls.disabled, false);
	app.input.value = 'replacement-key';
	await app.submit();
	assert.equal(app.data.apiKey, 'replacement-key');
});

test('a failed save preserves the old key and typed value, and permits retry', async context => {
	const app = setup({ apiKey: 'saved-key' });
	await app.ready;
	app.input.value = 'replacement-key';
	const fail = context.mock.method(app.storage, 'set', async () => {
		throw new Error('secret-key write failure');
	});
	await app.submit();
	assert.equal(app.data.apiKey, 'saved-key');
	assert.equal(app.input.value, 'replacement-key');
	assert.equal(app.status.textContent, 'Could not save the API key. Please try again.');
	assert.equal(app.controls.disabled, false);
	fail.mock.restore();
	await app.submit();
	assert.equal(app.data.apiKey, 'replacement-key');
	assert.equal(app.status.textContent, 'API key saved.');
});

test('a failed removal preserves the saved key and display, and permits retry', async context => {
	const app = setup({ apiKey: 'saved-key' });
	await app.ready;
	const fail = context.mock.method(app.storage, 'remove', async () => {
		throw new Error('secret-key removal failure');
	});
	await app.remove();
	assert.equal(app.data.apiKey, 'saved-key');
	assert.equal(app.input.value, 'saved-key');
	assert.equal(app.status.textContent, 'Could not remove the API key. Please try again.');
	assert.equal(app.controls.disabled, false);
	fail.mock.restore();
	await app.remove();
	assert.equal(app.data.apiKey, undefined);
	assert.equal(app.status.textContent, 'API key removed.');
});
