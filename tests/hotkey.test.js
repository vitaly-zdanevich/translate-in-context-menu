import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readSelection, registerHotkey } from '../src/hotkey.js';
import { normalizeServerUrl, publishTranslation } from '../src/bridge-client.js';

/** Supply a fake browser and relay; no selected text or keys leave the test. */
function setup(translation = async () => 'Привет') {
	const settings = { apiKey: 'google-test-key', phoneServerUrl: 'http://192.168.1.42:8787', phoneToken: 'a'.repeat(64) };
	const state = { text: 'Hello', notices: [], sent: [], opened: 0, calls: 0 };
	let listener;
	const browser = {
		commands: { onCommand: { addListener: callback => { listener = callback; } } },
		storage: { local: { get: async () => ({ ...settings }) } },
		runtime: { openOptionsPage: async () => { state.opened++; }, getURL: path => `moz-extension://test/${path}` },
		tabs: { query: async () => [{ id: 1, url: 'https://example.com/' }] },
		scripting: { executeScript: async () => [{ frameId: 0, result: state.text }] },
		notifications: { create: async (_id, value) => { state.notices.push(value); } },
	};
	const services = {
		translate: async (...args) => { state.calls++; return translation(...args); },
		publish: async (url, token, result, signal) => { state.sent.push({ url, token, result, signal }); },
	};
	registerHotkey(browser, services.translate, (...args) => services.publish(...args));
	return { browser, settings, state, services, press: (name = 'translate-on-phone') => listener(name) };
}

test('the shortcut publishes loading and translation without sending the Google credential', async () => {
	const app = setup(async (source, { apiKey }) => {
		assert.equal(source, 'Hello');
		assert.equal(apiKey, 'google-test-key');
		return 'Привет';
	});
	await app.press();
	assert.deepEqual(app.state.sent.map(item => item.result), [
		{ source: 'Hello', translation: '', error: '' },
		{ source: 'Hello', translation: 'Привет', error: '' },
	]);
	assert.ok(!JSON.stringify(app.state.sent).includes('google-test-key'));
	assert.equal(app.state.notices.length, 0);
});

test('unrelated commands, blank selections, and large selections do not translate', async () => {
	const app = setup();
	await app.press('another-command');
	assert.equal(app.state.notices.length, 0);
	for (const text of ['', ' '.repeat(10), '😀'.repeat(5001)]) {
		app.state.text = text;
		await app.press();
	}
	assert.equal(app.state.calls, 0);
	assert.equal(app.state.sent.length, 0);
	assert.equal(app.state.notices.length, 3);
});

test('missing settings open Preferences without a translation request', async () => {
	const app = setup();
	delete app.settings.phoneToken;
	await app.press();
	assert.equal(app.state.opened, 1);
	assert.equal(app.state.calls, 0);
	assert.equal(app.state.sent.length, 0);
});

test('restricted pages are reported through a native notification', async context => {
	const app = setup();
	context.mock.method(app.browser.tabs, 'query', async () => [{ id: 2, url: 'about:addons' }]);
	await app.press();
	assert.match(app.state.notices[0].message, /ordinary HTTP or HTTPS webpage/);
	assert.equal(app.state.calls, 0);
});

test('a disconnected relay prevents a potentially billable Google request', async () => {
	const app = setup();
	app.services.publish = async () => { throw new TypeError('Failed to fetch'); };
	await app.press();
	assert.equal(app.state.calls, 0);
	assert.match(app.state.notices[0].message, /local phone server/);
});

test('Google failures are displayed on the phone and are not cached', async () => {
	const app = setup(async () => { throw new Error('Test quota exceeded'); });
	await app.press();
	assert.deepEqual(app.state.sent.at(-1).result, { source: 'Hello', translation: '', error: 'Test quota exceeded' });
	await app.press();
	assert.equal(app.state.calls, 2);
});

test('successful translations stay cached until the API key changes', async () => {
	const app = setup();
	await app.press();
	await app.press();
	assert.equal(app.state.calls, 1);
	app.settings.apiKey = 'replacement-key';
	await app.press();
	assert.equal(app.state.calls, 2);
});

test('a late response from an earlier hotkey cannot replace the latest text', async () => {
	const first = Promise.withResolvers();
	const started = Promise.withResolvers();
	const app = setup(async source => {
		if (source === 'Hello') { started.resolve(); return first.promise; }
		return 'До свидания';
	});
	const old = app.press();
	await started.promise;
	app.state.text = 'Goodbye';
	await app.press();
	first.resolve('Привет');
	await old;
	assert.equal(app.state.sent.at(-1).result.translation, 'До свидания');
	assert.ok(!app.state.sent.some(item => item.result.translation === 'Привет'));
});

test('selection extraction uses the focused frame and excludes password inputs', () => {
	const run = (activeElement, focus = true) => vm.runInNewContext(`(${readSelection.toString()})()`, {
		document: { activeElement, hasFocus: () => focus },
		window: { getSelection: () => ({ toString: () => 'Selected page text' }) },
	});
	assert.equal(run({ tagName: 'BODY' }), 'Selected page text');
	assert.equal(run({ tagName: 'INPUT', type: 'text', value: 'Hello world', selectionStart: 6, selectionEnd: 11 }), 'world');
	assert.equal(run({ tagName: 'INPUT', type: 'password', value: 'secret', selectionStart: 0, selectionEnd: 6 }), '');
	assert.equal(run({ tagName: 'IFRAME' }), '');
	assert.equal(run({ tagName: 'BODY' }, false), '');
});

test('the phone URL accepts only loopback and private IPv4 HTTP servers', () => {
	for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.42']) {
		assert.equal(normalizeServerUrl(`http://${host}:8787/`), `http://${host}:8787`);
	}
	for (const value of ['invalid', 'https://192.168.1.42', 'http://example.com', 'http://8.8.8.8', 'http://172.32.0.1', 'http://0.0.0.0', 'http://user:secret@localhost', 'http://localhost/path', 'http://localhost/?token=secret']) {
		assert.throws(() => normalizeServerUrl(value));
	}
});

test('relay publication uses bearer authentication, no cookies, and the prescribed body', async context => {
	const capture = context.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
	const data = { source: 'Hello', translation: 'Привет', error: '' };
	await publishTranslation('http://192.168.1.42:8787', 'pairing-test-token', data, new AbortController().signal);
	const [url, options] = capture.mock.calls[0].arguments;
	assert.equal(url, 'http://192.168.1.42:8787/api/translation');
	assert.equal(options.headers.Authorization, 'Bearer pairing-test-token');
	assert.deepEqual(JSON.parse(options.body), data);
	assert.equal(options.credentials, 'omit');
	assert.equal(options.referrerPolicy, 'no-referrer');
	assert.ok(options.signal instanceof AbortSignal);
});

test('relay failures explain a bad pairing token or server status', async context => {
	const fetch = context.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }));
	await assert.rejects(publishTranslation('http://localhost:8787', 'bad', {}, new AbortController().signal), /pairing token was rejected/);
	fetch.mock.mockImplementation(async () => new Response(null, { status: 503 }));
	await assert.rejects(publishTranslation('http://localhost:8787', 'test', {}, new AbortController().signal), /HTTP 503/);
});
