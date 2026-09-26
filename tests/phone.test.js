import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const appUrl = new URL('../phone/app.js', import.meta.url);
const token = '0123456789abcdef'.repeat(4);

/** Model the DOM properties and events used by the phone viewer. */
function element() {
	const listeners = new Map();
	return {
		value: '',
		textContent: '',
		dateTime: '',
		hidden: false,
		focused: false,
		focus() { this.focused = true; },
		setAttribute(name, value) { this[name] = value; },
		removeAttribute(name) { delete this[name]; },
		addEventListener(name, listener) {
			const handlers = listeners.get(name) || [];
			handlers.push(listener);
			listeners.set(name, handlers);
		},
		fire(name, event = {}) {
			for (const listener of listeners.get(name) || []) {
				listener(event);
			}
		},
		set innerHTML(value) {
			throw new Error(`The viewer must render messages as text: ${value}`);
		},
	};
}

/** Run the real viewer against isolated storage and controllable SSE connections. */
function setup({ hash = '', saved = {} } = {}) {
	const data = { ...saved };
	const ids = [
		'pairing-form', 'pairing-token', 'pairing-error', 'connection-status',
		'forget-button', 'viewer', 'pairing', 'original', 'translation',
		'message-time', 'translation-error',
	];
	const elements = Object.fromEntries(ids.map(id => [id, element()]));
	elements.viewer.hidden = true;
	const streams = [];
	const replacements = [];
	const location = {
		href: `https://translate.example.test/${hash}`,
		origin: 'https://translate.example.test',
		pathname: '/',
		search: '',
		hash,
	};
	class EventSource {
		static CLOSED = 2;
		constructor(url) {
			this.url = String(url);
			this.closed = false;
			this.readyState = 0;
			this.listeners = new Map();
			streams.push(this);
		}
		close() { this.closed = true; }
		addEventListener(name, listener) { this.listeners.set(name, listener); }
		fire(name, data) {
			const event = { data };
			this[`on${name}`]?.(event);
			this.listeners.get(name)?.(event);
		}
		message(data) { this.fire('message', JSON.stringify(data)); }
	}
	const context = vm.createContext({
		document: {
			querySelector: selector => elements[selector.slice(1)],
			getElementById: id => elements[id],
		},
		localStorage: {
			getItem: key => data[key] ?? null,
			setItem: (key, value) => { data[key] = String(value); },
			removeItem: key => { delete data[key]; },
		},
		history: {
			replaceState: (state, title, url) => {
				replacements.push(String(url));
				const next = new URL(url, location.href);
				Object.assign(location, {
					href: next.href,
					pathname: next.pathname,
					search: next.search,
					hash: next.hash,
				});
			},
		},
		location,
		EventSource,
		URL,
		URLSearchParams,
	});
	context.window = context;
	const ready = vm.runInContext(readFileSync(appUrl, 'utf8'), context, {
		filename: appUrl.pathname,
	});
	return {
		elements, data, streams, replacements, location, ready,
		submit(value) {
			elements['pairing-token'].value = value;
			let prevented = false;
			elements['pairing-form'].fire('submit', {
				preventDefault: () => { prevented = true; },
			});
			assert.ok(prevented, 'pairing must prevent form navigation');
		},
		forget() { elements['forget-button'].fire('click'); },
	};
}

/** Read an SSE URL without depending on whether the app uses an absolute URL. */
function streamUrl(stream) {
	return new URL(stream.url, 'https://translate.example.test');
}

test('phone pairs from a fragment and removes the secret from browser history', () => {
	const app = setup({ hash: `#token=${token}` });
	assert.equal(app.data.pairingToken, token);
	assert.equal(app.location.hash, '');
	assert.equal(app.replacements.length, 1);
	assert.ok(!app.replacements[0].includes(token));
	assert.equal(app.streams.length, 1);
	assert.equal(streamUrl(app.streams[0]).pathname, '/events');
	assert.equal(streamUrl(app.streams[0]).searchParams.get('token'), token);
	assert.equal(app.elements.viewer.hidden, false);
	assert.equal(app.elements.pairing.hidden, true);
});

test('phone restores a saved pairing without persisting received translations', () => {
	const app = setup({ saved: { pairingToken: token, unrelated: 'keep' } });
	assert.equal(app.streams.length, 1);
	app.streams[0].message({
		source: 'Hello', translation: 'Привет', error: '',
		updatedAt: '2026-09-21T10:00:00.000Z',
	});
	assert.deepEqual(app.data, { pairingToken: token, unrelated: 'keep' });
});

test('phone rejects missing and malformed pairing tokens before connecting', () => {
	for (const value of ['', 'short', 'g'.repeat(64), token.slice(1), `${token}0`]) {
		const app = setup();
		app.submit(value);
		assert.equal(app.streams.length, 0);
		assert.equal(app.data.pairingToken, undefined);
		assert.ok(app.elements['pairing-error'].textContent);
		assert.equal(app.elements.viewer.hidden, true);
		assert.equal(app.elements.pairing.hidden, false);
	}
});

test('phone trims manual pairing tokens and clears a previous validation error', () => {
	const app = setup();
	app.submit('invalid');
	app.submit(` \t${token.toUpperCase()}\n `);
	assert.equal(app.streams.length, 1);
	assert.equal(app.data.pairingToken.toLowerCase(), token);
	assert.equal(streamUrl(app.streams[0]).searchParams.get('token').toLowerCase(), token);
	assert.equal(app.elements['pairing-error'].textContent, '');
	assert.equal(app.elements.viewer.hidden, false);
	assert.equal(app.elements.pairing.hidden, true);
});

test('phone ignores a malformed saved token and allows a replacement pairing', () => {
	const app = setup({ saved: { pairingToken: 'not-a-token' } });
	assert.equal(app.streams.length, 0);
	assert.equal(app.elements.pairing.hidden, false);
	app.submit(token);
	assert.equal(app.streams.length, 1);
	assert.equal(app.data.pairingToken, token);
});

test('phone renders source and translation literally and shows the update time', () => {
	const app = setup({ saved: { pairingToken: token } });
	const source = '<img src=x onerror=alert(1)> & hello';
	const translation = '<script>alert("Привет")</script>';
	const updatedAt = '2026-09-21T10:00:00.000Z';
	app.streams[0].message({ source, translation, updatedAt });
	assert.equal(app.elements.original.textContent, source);
	assert.equal(app.elements.translation.textContent, translation);
	assert.ok(app.elements['message-time'].textContent);
	assert.equal(new Date(app.elements['message-time'].dateTime).toISOString(), updatedAt);
	assert.equal(app.elements['translation-error'].textContent, '');
});

test('phone reports reconnection and recovers when the same stream opens again', () => {
	const app = setup({ saved: { pairingToken: token } });
	const stream = app.streams[0];
	stream.fire('open');
	assert.match(app.elements['connection-status'].textContent, /connected/i);
	stream.fire('error');
	assert.match(app.elements['connection-status'].textContent, /reconnect/i);
	stream.fire('open');
	assert.match(app.elements['connection-status'].textContent, /connected/i);
	assert.equal(app.streams.length, 1, 'EventSource should manage its own reconnection');
	assert.equal(stream.closed, false);
});

test('phone handles malformed messages and recovers on the next translation', () => {
	const app = setup({ saved: { pairingToken: token } });
	const stream = app.streams[0];
	assert.doesNotThrow(() => stream.fire('message', '{invalid JSON'));
	assert.ok(app.elements['translation-error'].textContent);
	stream.message({
		source: 'Hello', translation: 'Привет', error: '',
		updatedAt: '2026-09-21T10:00:00.000Z',
	});
	assert.equal(app.elements.original.textContent, 'Hello');
	assert.equal(app.elements.translation.textContent, 'Привет');
	assert.equal(app.elements['translation-error'].textContent, '');
});

test('phone displays a translation error as text and handles invalid dates safely', () => {
	const app = setup({ saved: { pairingToken: token } });
	const error = '<img src=x onerror=alert(1)> Provider unavailable';
	assert.doesNotThrow(() => app.streams[0].message({
		source: 'Hello', translation: '', error, updatedAt: 'not-a-date',
	}));
	assert.equal(app.elements['translation-error'].textContent, error);
	assert.ok(!app.elements['message-time'].textContent.includes('Invalid Date'));
});

test('forgetting a phone closes its connection, clears private content, and ignores late events', () => {
	const app = setup({ saved: { pairingToken: token, unrelated: 'keep' } });
	const stream = app.streams[0];
	stream.message({
		source: 'Private source', translation: 'Личный перевод', error: 'Private error',
		updatedAt: '2026-09-21T10:00:00.000Z',
	});
	app.forget();
	assert.equal(stream.closed, true);
	assert.deepEqual(app.data, { unrelated: 'keep' });
	assert.equal(app.elements.viewer.hidden, true);
	assert.equal(app.elements.pairing.hidden, false);
	assert.equal(app.elements['pairing-token'].value, '');
	for (const id of ['original', 'translation', 'message-time', 'translation-error']) {
		assert.equal(app.elements[id].textContent, '');
	}
	const status = app.elements['connection-status'].textContent;
	stream.fire('open');
	stream.fire('error');
	stream.message({ source: 'Stale source', translation: 'Stale translation' });
	assert.equal(app.elements.original.textContent, '');
	assert.equal(app.elements.translation.textContent, '');
	assert.equal(app.elements['connection-status'].textContent, status);
	assert.equal(app.elements.viewer.hidden, true);
});

test('an invalid pairing link is removed from the URL without opening a connection', () => {
	const app = setup({ hash: '#token=invalid', saved: { pairingToken: token } });
	assert.equal(app.location.hash, '');
	assert.equal(app.streams.length, 0);
	assert.equal(app.elements.pairing.hidden, false);
	assert.match(app.elements['pairing-error'].textContent, /invalid/i);
});

test('an SSE connection that has permanently closed tells the phone to pair again', () => {
	const app = setup({ saved: { pairingToken: token } });
	app.streams[0].readyState = 2;
	app.streams[0].fire('error');
	assert.match(app.elements['connection-status'].textContent, /disconnected.*pair again/i);
});

test('invalid message shapes preserve the last readable translation', () => {
	const app = setup({ saved: { pairingToken: token } });
	const stream = app.streams[0];
	stream.message({ source: 'Hello', translation: 'Привет' });
	for (const message of [null, [], 42, { source: {} }, { translation: [] }, { error: false }]) {
		assert.doesNotThrow(() => stream.message(message));
		assert.ok(app.elements['translation-error'].textContent);
		assert.equal(app.elements.original.textContent, 'Hello');
		assert.equal(app.elements.translation.textContent, 'Привет');
	}
});

test('phone displays the newly selected source while its translation is pending', () => {
	const app = setup({ saved: { pairingToken: token } });
	const stream = app.streams[0];
	stream.message({ source: 'Previous selection', translation: 'Предыдущий перевод' });
	stream.message({
		source: 'A new selection', translation: '', error: '',
		updatedAt: '2026-09-21T10:00:00.000Z',
	});
	assert.equal(app.elements.original.textContent, 'A new selection');
	assert.equal(app.elements.translation.textContent, 'Переводим…');
	assert.equal(app.elements['translation-error'].textContent, '');
	stream.message({ source: 'A new selection', translation: 'Новое выделение', error: '' });
	assert.equal(app.elements.translation.textContent, 'Новое выделение');
});

test('phone explains how to start when the server has no selected text yet', () => {
	const app = setup({ saved: { pairingToken: token } });
	app.streams[0].message({ source: '', translation: '', error: '', updatedAt: '' });
	assert.equal(app.elements.original.textContent, '');
	assert.match(app.elements.translation.textContent, /select text.*shortcut/i);
	assert.equal(app.elements['translation-error'].textContent, '');
	assert.equal(app.elements['message-time'].textContent, '');
});
