import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { pasteIntoYandex, registerYandexShortcut } from '../src/yandex.js';

/** Mock tabs in separate windows without contacting Google, Yandex, or the relay. */
function setup() {
	const state = {
		source: { id: 1, windowId: 1, url: 'https://example.com/' },
		text: 'Selected text',
		candidates: [{ id: 2, windowId: 2, active: true, lastAccessed: 1 }],
		queries: [],
		reads: [],
		writes: [],
		updates: [],
		notices: [],
	};
	const services = {
		read: async () => [{ frameId: 0, result: state.text }],
		paste: async () => [{ frameId: 0, result: { ok: true } }],
	};
	let listener;
	const browser = {
		commands: { onCommand: { addListener: callback => { listener = callback; } } },
		tabs: {
			query: async query => {
				state.queries.push(query);
				return query.url ? state.candidates : [state.source].filter(Boolean);
			},
			update: async (id, changes) => { state.updates.push({ id, changes }); },
		},
		scripting: {
			executeScript: async options => {
				if (options.target.tabId === state.source?.id) {
					state.reads.push(options);
					return services.read(options);
				}
				state.writes.push(options);
				return services.paste(options);
			},
		},
		runtime: { getURL: path => `moz-extension://test/${path}` },
		notifications: { create: async (_id, notice) => { state.notices.push(notice); } },
	};
	registerYandexShortcut(browser);
	return { browser, state, services, press: (command = 'paste-in-yandex') => listener(command) };
}

test('Yandex shortcut sends the exact selection to the existing other-window tab', async context => {
	const fetch = context.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
	const app = setup();
	app.state.text = '  A & B\nПривет 😀  ';
	await app.press();
	assert.deepEqual(app.state.queries, [
		{ active: true, currentWindow: true },
		{ url: 'https://translate.yandex.ru/*' },
	]);
	assert.equal(app.state.reads.length, 1);
	assert.equal(app.state.reads[0].target.allFrames, true);
	assert.equal(app.state.writes.length, 1);
	const [write] = app.state.writes;
	assert.deepEqual(write.target, { tabId: 2 });
	assert.equal(write.func, pasteIntoYandex);
	assert.deepEqual(write.args, [app.state.text]);
	assert.equal(write.injectImmediately, true);
	assert.deepEqual(app.state.updates, []);
	assert.deepEqual(app.state.notices, []);
	assert.equal(fetch.mock.calls.length, 0);
});

test('destination selection prefers another window, then active tabs, then recent tabs', async () => {
	const app = setup();
	app.state.candidates = [
		{ id: 1, windowId: 1, active: true, lastAccessed: 1000 },
		{ id: 2, windowId: 1, active: true, lastAccessed: 900 },
		{ id: 3, windowId: 2, active: false, lastAccessed: 800 },
		{ id: 4, windowId: 3, active: true, lastAccessed: 100 },
		{ id: 5, windowId: 4, active: true, lastAccessed: 200 },
	];
	await app.press();
	assert.equal(app.state.writes[0].target.tabId, 5);
	assert.deepEqual(app.state.updates, []);
});

test('an inactive destination becomes visible without focusing its window', async () => {
	const app = setup();
	app.state.candidates = [
		{ id: 2, windowId: 1, active: false, lastAccessed: 900 },
		{ id: 3, windowId: 2, active: false, lastAccessed: 100 },
	];
	await app.press();
	assert.equal(app.state.writes[0].target.tabId, 3);
	assert.deepEqual(app.state.updates, [{ id: 3, changes: { active: true } }]);
	assert.deepEqual(app.state.notices, []);
});

test('another tab in the source window remains a valid fallback', async () => {
	const app = setup();
	app.state.candidates = [{ id: 3, windowId: 1, active: false, lastAccessed: 1 }];
	await app.press();
	assert.equal(app.state.writes[0].target.tabId, 3);
	assert.deepEqual(app.state.updates, [{ id: 3, changes: { active: true } }]);
});

test('unrelated shortcuts do not read selections or show errors', async () => {
	const app = setup();
	await app.press('translate-on-phone');
	assert.deepEqual(app.state.queries, []);
	assert.deepEqual(app.state.writes, []);
	assert.deepEqual(app.state.notices, []);
});

test('blank selections and restricted source pages produce a notification without a write', async () => {
	for (const source of [undefined, { id: 1, windowId: 1, url: 'about:addons' }]) {
		const app = setup();
		app.state.source = source;
		await app.press();
		assert.equal(app.state.notices.length, 1);
		assert.equal(app.state.reads.length, 0);
		assert.equal(app.state.writes.length, 0);
	}
	for (const text of ['', ' \n\t ']) {
		const app = setup();
		app.state.text = text;
		await app.press();
		assert.equal(app.state.notices.length, 1);
		assert.equal(app.state.writes.length, 0);
	}
});

test('selection can come from a focused child frame', async () => {
	const app = setup();
	app.services.read = async () => [
		{ frameId: 0, result: '' },
		{ frameId: 3, result: 'Inside the frame' },
	];
	await app.press();
	assert.deepEqual(app.state.writes[0].args, ['Inside the frame']);
});

test('no destination, including only the source tab, leaves the selection untouched', async () => {
	for (const candidates of [[], [{ id: 1, windowId: 1, active: true }]]) {
		const app = setup();
		app.state.candidates = candidates;
		await app.press();
		assert.equal(app.state.notices.length, 1);
		assert.equal(app.state.writes.length, 0);
		assert.equal(app.state.updates.length, 0);
	}
});

test('missing Yandex editor and rejected injection report errors through notifications', async () => {
	for (const paste of [
		async () => [{ frameId: 0, result: { error: 'Yandex editor #textarea was not found.' } }],
		async () => { throw new Error('The destination tab was closed.'); },
	]) {
		const app = setup();
		app.services.paste = paste;
		await app.press();
		assert.equal(app.state.notices.length, 1);
		assert.ok(app.state.notices[0].message.length > 0);
	}
	const app = setup();
	app.services.read = async () => { throw new Error('Cannot access this page.'); };
	await app.press();
	assert.equal(app.state.notices.length, 1);
	assert.equal(app.state.writes.length, 0);
});

test('a slow earlier selection cannot overwrite a newer shortcut', async () => {
	const app = setup();
	const oldSelection = Promise.withResolvers();
	const started = Promise.withResolvers();
	let reads = 0;
	app.services.read = async () => {
		if (++reads === 1) {
			started.resolve();
			return oldSelection.promise;
		}
		return [{ frameId: 0, result: 'New selection' }];
	};
	const old = app.press();
	await started.promise;
	await app.press();
	oldSelection.resolve([{ frameId: 0, result: 'Old selection' }]);
	await old;
	assert.deepEqual(app.state.writes.map(write => write.args[0]), ['New selection']);
	assert.equal(app.state.notices.length, 0);
});

test('destination writes are serialized so the final text is from the latest shortcut', async () => {
	const app = setup();
	const releaseFirst = Promise.withResolvers();
	const started = Promise.withResolvers();
	const completed = [];
	let pending = 0;
	let maximumPending = 0;
	app.services.paste = async options => {
		pending++;
		maximumPending = Math.max(maximumPending, pending);
		if (options.args[0] === 'Selected text') {
			started.resolve();
			await releaseFirst.promise;
		}
		completed.push(options.args[0]);
		pending--;
		return [{ frameId: 0, result: { ok: true } }];
	};
	const first = app.press();
	await started.promise;
	app.state.text = 'Latest text';
	const second = app.press();
	await new Promise(resolve => setImmediate(resolve));
	releaseFirst.resolve();
	await Promise.all([first, second]);
	assert.equal(maximumPending, 1);
	assert.deepEqual(completed, ['Selected text', 'Latest text']);
	assert.equal(app.state.notices.length, 0);
});

/** Provide DOM-shaped objects to exercise the function injected into the Yandex tab. */
function editorFixture(kind = 'textarea', origin = 'https://translate.yandex.ru') {
	const events = [];
	const changes = [];
	class Element {
		constructor() {
			this.textContent = '';
			this.isContentEditable = false;
		}
		dispatchEvent(event) { events.push(event); return true; }
		focus() {}
	}
	class HTMLTextAreaElement extends Element {
		constructor() { super(); this.tagName = 'TEXTAREA'; this.storedValue = ''; this.disabled = false; this.readOnly = false; }
		get value() { return this.storedValue; }
		set value(value) { this.storedValue = value; changes.push(value); }
	}
	class HTMLInputElement extends Element {
		constructor() { super(); this.tagName = 'INPUT'; this.storedValue = ''; }
		get value() { return this.storedValue; }
		set value(value) { this.storedValue = value; changes.push(value); }
	}
	class Event {
		constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
	}
	class InputEvent extends Event {}
	let editor = kind === 'textarea' ? new HTMLTextAreaElement() : kind === 'input' ? new HTMLInputElement() : new Element();
	if (kind === 'contenteditable') {
		editor.tagName = 'DIV';
		editor.isContentEditable = true;
	} else if (kind === 'missing') {
		editor = null;
	}
	const context = {
		document: {
			getElementById: id => id === 'textarea' ? editor : null,
			querySelector: selector => selector === '#textarea' ? editor : null,
		},
		location: { origin },
		HTMLTextAreaElement,
		HTMLInputElement,
		Event,
		InputEvent,
	};
	context.window = context;
	return {
		editor, events, changes,
		run: text => vm.runInNewContext(`(${pasteIntoYandex.toString()})(${JSON.stringify(text)})`, context),
	};
}

test('textarea paste uses the native setter and notifies page listeners', () => {
	const fixture = editorFixture();
	Object.defineProperty(fixture.editor, 'value', {
		get() { return this.storedValue; },
		set() { throw new Error('A framework-owned setter must not intercept the native update.'); },
	});
	const text = '  <b>literal</b>\nПривет 😀  ';
	const result = fixture.run(text);
	assert.equal(result.ok, true);
	assert.equal(fixture.editor.value, text);
	assert.deepEqual(fixture.changes, [text]);
	assert.deepEqual(fixture.events.map(event => event.type), ['input', 'change']);
	assert.ok(fixture.events.every(event => event.bubbles));
	assert.equal(fixture.events[0].inputType, 'insertFromPaste');
	assert.equal(fixture.events[0].data, text);
});

test('paste refuses a navigated destination, absent editor, or unexpected element type', () => {
	for (const fixture of [
		editorFixture('textarea', 'https://example.com'),
		editorFixture('missing'),
		editorFixture('plain'),
		editorFixture('input'),
		editorFixture('contenteditable'),
	]) {
		const result = fixture.run('Do not insert');
		assert.ok(typeof result.error === 'string' && result.error.length > 0);
		assert.deepEqual(fixture.events, []);
		assert.deepEqual(fixture.changes, []);
	}
});

test('paste leaves disabled and read-only textareas untouched', () => {
	for (const property of ['disabled', 'readOnly']) {
		const fixture = editorFixture();
		fixture.editor[property] = true;
		const result = fixture.run('Do not insert');
		assert.ok(typeof result.error === 'string' && result.error.length > 0);
		assert.deepEqual(fixture.events, []);
		assert.deepEqual(fixture.changes, []);
	}
});
