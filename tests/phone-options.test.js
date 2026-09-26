import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { normalizeServerUrl } from '../src/bridge-client.js';

const optionsUrl = new URL('../src/phone-options.js', import.meta.url);
const optionsSource = readFileSync(optionsUrl, 'utf8');
const bridgeImport = "import { normalizeServerUrl } from './bridge-client.js';";
assert.ok(optionsSource.startsWith(bridgeImport), 'inject the real URL validator in place of its import');
const script = optionsSource.slice(bridgeImport.length);
const savedUrl = 'http://192.168.1.42:8787';
const savedToken = 'a1'.repeat(32);

/** Mock only the DOM properties and events used by the phone preferences form. */
function element() {
	const listeners = new Map();
	return {
		value: '',
		textContent: '',
		disabled: false,
		addEventListener: (name, listener) => listeners.set(name, listener),
		fire: (name, event) => listeners.get(name)(event),
	};
}

/** Run the real form with isolated storage and its real server URL validation. */
function setup(saved = {}, overrides = {}) {
	const data = { ...saved };
	const calls = { reads: [], writes: [], removals: [], fetches: 0 };
	const elements = Object.fromEntries(
		['phone-settings', 'phone-controls', 'phone-url', 'phone-token', 'phone-status', 'remove-phone']
			.map(id => [id, element()]),
	);
	elements['phone-controls'].disabled = true;
	const storage = {
		get: async keys => { calls.reads.push([...keys]); return { ...data }; },
		set: async values => { calls.writes.push({ ...values }); Object.assign(data, values); },
		remove: async keys => {
			calls.removals.push([...keys]);
			for (const key of keys) delete data[key];
		},
		...overrides,
	};
	const ready = vm.runInNewContext(script, {
		document: { querySelector: selector => elements[selector.slice(1)] },
		browser: { storage: { local: storage } },
		normalizeServerUrl,
		fetch: () => { calls.fetches++; throw new Error('Preferences must not make requests'); },
	}, { filename: optionsUrl.pathname });

	return {
		ready, data, calls, storage,
		url: elements['phone-url'],
		token: elements['phone-token'],
		controls: elements['phone-controls'],
		status: elements['phone-status'],
		submit: () => {
			let prevented = false;
			const result = elements['phone-settings'].fire('submit', {
				preventDefault: () => { prevented = true; },
			});
			assert.ok(prevented, 'saving must prevent form navigation');
			return result;
		},
		remove: () => elements['remove-phone'].fire('click'),
	};
}

test('phone preferences load only their settings without writes or network requests', async () => {
	const app = setup({ phoneServerUrl: savedUrl, phoneToken: savedToken, apiKey: 'google-key' });
	assert.equal(app.controls.disabled, true);
	await app.ready;
	assert.equal(app.url.value, savedUrl);
	assert.equal(app.token.value, savedToken);
	assert.equal(app.controls.disabled, false);
	assert.deepEqual(app.calls, {
		reads: [['phoneServerUrl', 'phoneToken']], writes: [], removals: [], fetches: 0,
	});
	assert.equal(app.data.apiKey, 'google-key');
});

test('missing phone settings leave both inputs empty and editable', async () => {
	for (const saved of [{}, { phoneServerUrl: null, phoneToken: null }]) {
		const app = setup(saved);
		await app.ready;
		assert.equal(app.url.value, '');
		assert.equal(app.token.value, '');
		assert.equal(app.controls.disabled, false);
	}
});

test('saving trims a private HTTP URL and token without changing the Google API key', async () => {
	const app = setup({ apiKey: 'google-key', unrelated: 'keep' });
	await app.ready;
	app.url.value = ` \t${savedUrl}/\n `;
	app.token.value = ` \n${savedToken.toUpperCase()}\t `;
	const saving = app.submit();
	assert.equal(app.controls.disabled, true);
	await saving;
	assert.deepEqual(app.data, {
		apiKey: 'google-key', unrelated: 'keep', phoneServerUrl: savedUrl, phoneToken: savedToken.toUpperCase(),
	});
	assert.deepEqual(app.calls.writes, [{ phoneServerUrl: savedUrl, phoneToken: savedToken.toUpperCase() }]);
	assert.equal(app.url.value, savedUrl);
	assert.equal(app.token.value, savedToken.toUpperCase());
	assert.equal(app.status.textContent, 'Phone connection saved.');
	assert.equal(app.controls.disabled, false);
	assert.equal(app.calls.fetches, 0);
});

test('phone preferences accept localhost and each supported private IPv4 range', async () => {
	for (const url of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://10.0.0.2:8787', 'http://172.16.0.2:8787', savedUrl]) {
		const app = setup();
		await app.ready;
		app.url.value = url;
		app.token.value = savedToken;
		await app.submit();
		assert.equal(app.data.phoneServerUrl, url);
		assert.equal(app.data.phoneToken, savedToken);
		assert.equal(app.calls.fetches, 0);
	}
});

test('invalid server addresses cannot replace an existing phone connection', async () => {
	for (const url of [
		'', 'not a URL', 'https://192.168.1.42:8787', 'http://example.com:8787',
		'http://8.8.8.8:8787', 'http://172.32.0.1:8787', 'http://user:password@192.168.1.42:8787',
		`${savedUrl}/display`, `${savedUrl}?token=wrong`, `${savedUrl}#token`,
	]) {
		const saved = { phoneServerUrl: savedUrl, phoneToken: savedToken, apiKey: 'google-key' };
		const app = setup(saved);
		await app.ready;
		app.url.value = url;
		app.token.value = 'b2'.repeat(32);
		await app.submit();
		assert.deepEqual(app.data, saved, `must reject ${url}`);
		assert.equal(app.calls.writes.length, 0);
		assert.equal(app.calls.removals.length, 0);
		assert.equal(app.calls.fetches, 0);
		assert.match(app.status.textContent, /local server URL|HTTP server/);
		assert.equal(app.controls.disabled, false);
	}
});

test('invalid pairing tokens cannot replace an existing phone connection', async () => {
	for (const token of ['', ' \n\t ', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), `${'a'.repeat(31)} ${'a'.repeat(32)}`]) {
		const saved = { phoneServerUrl: savedUrl, phoneToken: savedToken, apiKey: 'google-key' };
		const app = setup(saved);
		await app.ready;
		app.url.value = 'http://10.0.0.2:8787';
		app.token.value = token;
		await app.submit();
		assert.deepEqual(app.data, saved);
		assert.equal(app.calls.writes.length, 0);
		assert.equal(app.calls.removals.length, 0);
		assert.equal(app.calls.fetches, 0);
		assert.match(app.status.textContent, /64-character pairing token/);
		assert.equal(app.controls.disabled, false);
	}
});

test('removing the phone connection preserves the Google API key and other settings', async () => {
	const app = setup({ phoneServerUrl: savedUrl, phoneToken: savedToken, apiKey: 'google-key', unrelated: 'keep' });
	await app.ready;
	const removing = app.remove();
	assert.equal(app.controls.disabled, true);
	await removing;
	assert.deepEqual(app.data, { apiKey: 'google-key', unrelated: 'keep' });
	assert.deepEqual(app.calls.removals, [['phoneServerUrl', 'phoneToken']]);
	assert.equal(app.url.value, '');
	assert.equal(app.token.value, '');
	assert.equal(app.status.textContent, 'Phone connection removed.');
	assert.equal(app.controls.disabled, false);
	assert.equal(app.calls.fetches, 0);
});

test('a failed phone settings load restores the controls and permits saving', async () => {
	const app = setup({ apiKey: 'google-key' }, {
		get: async () => { throw new Error('storage read failed'); },
	});
	await app.ready;
	assert.equal(app.status.textContent, 'Could not load phone settings. Reopen Preferences to retry.');
	assert.equal(app.controls.disabled, false);
	app.url.value = savedUrl;
	app.token.value = savedToken;
	await app.submit();
	assert.equal(app.data.phoneServerUrl, savedUrl);
	assert.equal(app.data.phoneToken, savedToken);
	assert.equal(app.data.apiKey, 'google-key');
	assert.equal(app.calls.fetches, 0);
});

test('a failed phone settings save preserves the connection and typed values for retry', async context => {
	const saved = { phoneServerUrl: savedUrl, phoneToken: savedToken, apiKey: 'google-key' };
	const app = setup(saved);
	await app.ready;
	app.url.value = 'http://10.0.0.2:8787';
	app.token.value = 'b2'.repeat(32);
	const fail = context.mock.method(app.storage, 'set', async () => { throw new Error('storage write failed'); });
	await app.submit();
	assert.deepEqual(app.data, saved);
	assert.equal(app.url.value, 'http://10.0.0.2:8787');
	assert.equal(app.token.value, 'b2'.repeat(32));
	assert.ok(app.status.textContent);
	assert.equal(app.controls.disabled, false);
	fail.mock.restore();
	await app.submit();
	assert.equal(app.data.phoneServerUrl, 'http://10.0.0.2:8787');
	assert.equal(app.data.phoneToken, 'b2'.repeat(32));
	assert.equal(app.data.apiKey, 'google-key');
	assert.equal(app.status.textContent, 'Phone connection saved.');
	assert.equal(app.calls.fetches, 0);
});

test('a failed phone connection removal preserves its display and permits retry', async context => {
	const saved = { phoneServerUrl: savedUrl, phoneToken: savedToken, apiKey: 'google-key' };
	const app = setup(saved);
	await app.ready;
	const fail = context.mock.method(app.storage, 'remove', async () => { throw new Error('storage removal failed'); });
	await app.remove();
	assert.deepEqual(app.data, saved);
	assert.equal(app.url.value, savedUrl);
	assert.equal(app.token.value, savedToken);
	assert.equal(app.status.textContent, 'Could not remove phone settings. Please try again.');
	assert.equal(app.controls.disabled, false);
	fail.mock.restore();
	await app.remove();
	assert.deepEqual(app.data, { apiKey: 'google-key' });
	assert.equal(app.status.textContent, 'Phone connection removed.');
	assert.equal(app.calls.fetches, 0);
});
