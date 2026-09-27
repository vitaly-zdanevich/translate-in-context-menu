import assert from 'node:assert/strict';
import test from 'node:test';
import { readSelection } from '../src/hotkey.js';
import { registerNotificationShortcut } from '../src/notification.js';

/** Replace Firefox and Google with local fixtures, recording visible side effects. */
function setup(translation = async () => 'Привет') {
	const settings = { apiKey: 'google-test-key' };
	const state = {
		text: 'Hello',
		tab: { id: 1, url: 'https://example.com/' },
		keys: [],
		queries: [],
		reads: [],
		calls: [],
		notices: [],
		changes: [],
		opened: 0,
	};
	const services = {
		settings: async () => ({ ...settings }),
		selection: async () => [{ frameId: 0, result: state.text }],
		notify: async (id, notice) => { state.notices.push({ id, ...notice }); return id; },
	};
	let listener;
	const browser = {
		commands: { onCommand: { addListener: callback => { listener = callback; } } },
		storage: { local: { get: async keys => { state.keys.push(keys); return services.settings(); } } },
		runtime: {
			getURL: path => `moz-extension://test/${path}`,
			openOptionsPage: async () => { state.opened++; },
		},
		tabs: {
			query: async query => { state.queries.push(query); return [state.tab].filter(Boolean); },
			create: async value => { state.changes.push({ action: 'create-tab', value }); },
			update: async (id, value) => { state.changes.push({ action: 'update-tab', id, value }); },
		},
		windows: { update: async (id, value) => { state.changes.push({ action: 'update-window', id, value }); } },
		scripting: { executeScript: async options => { state.reads.push(options); return services.selection(options); } },
		notifications: { create: (...args) => services.notify(...args) },
	};
	registerNotificationShortcut(browser, async (...args) => {
		state.calls.push(args);
		return translation(...args);
	});
	return { browser, state, settings, services, press: (name = 'translate-in-notification') => listener(name) };
}

test('the notification shortcut shows the complete translation without changing tabs or focus', async () => {
	const translation = 'Перевод & <текст>\n'.repeat(20);
	const app = setup(async () => translation);
	app.settings.apiKey = '  google-test-key  ';
	app.state.text = '  Hello\nworld  ';
	await app.press();
	assert.deepEqual(app.state.keys.flat(), ['apiKey', 'targetLanguage']);
	assert.deepEqual(app.state.queries, [{ active: true, currentWindow: true }]);
	assert.deepEqual(app.state.reads[0].target, { tabId: 1, allFrames: true });
	assert.equal(app.state.reads[0].func, readSelection);
	assert.equal(app.state.calls.length, 1);
	const [source, options] = app.state.calls[0];
	assert.equal(source, 'Hello\nworld');
	assert.equal(options.apiKey, 'google-test-key');
	assert.equal(options.targetLanguage, 'ru');
	assert.ok(options.signal instanceof AbortSignal);
	assert.deepEqual(app.state.notices, [{
		id: 'selection-translation',
		type: 'basic',
		iconUrl: 'moz-extension://test/icons/translate.svg',
		title: 'Translation — Russian',
		message: translation,
	}]);
	assert.equal(app.state.opened, 0);
	assert.deepEqual(app.state.changes, []);
});

test('unrelated shortcuts do not read settings or show a notification', async () => {
	const app = setup();
	await app.press('translate-on-phone');
	await app.press('paste-in-yandex');
	assert.deepEqual(app.state.keys, []);
	assert.deepEqual(app.state.reads, []);
	assert.deepEqual(app.state.calls, []);
	assert.deepEqual(app.state.notices, []);
});

test('a missing or blank API key opens Preferences and explains setup without contacting Google', async () => {
	for (const apiKey of [undefined, '', ' \n\t ']) {
		const app = setup();
		app.settings.apiKey = apiKey;
		await app.press();
		assert.equal(app.state.opened, 1);
		assert.equal(app.state.calls.length, 0);
		assert.equal(app.state.reads.length, 0);
		assert.equal(app.state.notices.length, 1);
		assert.match(app.state.notices[0].message, /API/i);
	}
});

test('restricted pages and absent tabs are reported without reading page content', async () => {
	for (const tab of [undefined, { id: 1, url: 'about:addons' }, { id: 1, url: 'file:///tmp/selection.html' }]) {
		const app = setup();
		app.state.tab = tab;
		await app.press();
		assert.equal(app.state.notices.length, 1);
		assert.equal(app.state.reads.length, 0);
		assert.equal(app.state.calls.length, 0);
	}
});

test('empty selections and selections exceeding 5000 code points never reach Google', async () => {
	for (const text of ['', ' \t\n ', '😀'.repeat(5001)]) {
		const app = setup();
		app.state.text = text;
		await app.press();
		assert.equal(app.state.notices.length, 1);
		assert.equal(app.state.calls.length, 0);
	}
});

test('exactly 5000 Unicode code points and selections from focused child frames are accepted', async () => {
	const app = setup();
	const source = '😀'.repeat(5000);
	app.services.selection = async () => [
		{ frameId: 0, result: '' },
		{ frameId: 2, result: source },
	];
	await app.press();
	assert.equal(app.state.calls[0][0], source);
	assert.equal(app.state.notices[0].message, 'Привет');
});

test('selection injection failures produce a native error without a Google request', async () => {
	const app = setup();
	app.services.selection = async () => { throw new Error('Cannot access this page.'); };
	await app.press();
	assert.equal(app.state.calls.length, 0);
	assert.equal(app.state.notices.length, 1);
	assert.match(app.state.notices[0].message, /Cannot access this page/);
});

test('only the completed translation appears, with no intermediate loading notification', async () => {
	const result = Promise.withResolvers();
	const started = Promise.withResolvers();
	const app = setup(async () => { started.resolve(); return result.promise; });
	const pending = app.press();
	await started.promise;
	assert.deepEqual(app.state.notices, []);
	result.resolve('Готовый перевод');
	await pending;
	assert.deepEqual(app.state.notices.map(notice => notice.message), ['Готовый перевод']);
});

test('successful translations remain cached without a count limit until the API key changes', async () => {
	const app = setup(async source => `Перевод: ${source}`);
	for (let index = 0; index < 102; index++) {
		app.state.text = `Selection ${index}`;
		await app.press();
	}
	app.state.text = 'Selection 0';
	await app.press();
	assert.equal(app.state.calls.length, 102);
	assert.equal(app.state.notices.at(-1).message, 'Перевод: Selection 0');
	app.settings.apiKey = 'replacement-key';
	await app.press();
	assert.equal(app.state.calls.length, 103);
	assert.equal(app.state.calls.at(-1)[1].apiKey, 'replacement-key');
});

test('removing the API key clears cached translations even if the same key is restored', async () => {
	const app = setup();
	await app.press();
	delete app.settings.apiKey;
	await app.press();
	app.settings.apiKey = 'google-test-key';
	await app.press();
	assert.equal(app.state.calls.length, 2);
	assert.equal(app.state.opened, 1);
});

test('notifications use the chosen language and cache translations separately for each target', async () => {
	const app = setup(async (_source, { targetLanguage }) => targetLanguage === 'de' ? 'Hallo' : 'Привет');
	await app.press();
	app.settings.targetLanguage = 'de';
	await app.press();
	assert.equal(app.state.calls.at(-1)[1].targetLanguage, 'de');
	assert.equal(app.state.notices.at(-1).title, 'Translation — German');
	assert.equal(app.state.notices.at(-1).message, 'Hallo');
	app.settings.targetLanguage = 'ru';
	await app.press();
	assert.equal(app.state.calls.length, 2);
	assert.equal(app.state.notices.at(-1).title, 'Translation — Russian');
	assert.equal(app.state.notices.at(-1).message, 'Привет');
});

test('an unfinished notification cannot replace a translation in the newly chosen language', async () => {
	const first = Promise.withResolvers();
	const started = Promise.withResolvers();
	const app = setup(async (_source, { targetLanguage }) => {
		if (targetLanguage === 'ru') { started.resolve(); return first.promise; }
		return 'Hallo';
	});
	const old = app.press();
	await started.promise;
	app.settings.targetLanguage = 'de';
	await app.press();
	first.resolve('Привет');
	await old;
	assert.deepEqual(app.state.notices.map(({ title, message }) => ({ title, message })), [
		{ title: 'Translation — German', message: 'Hallo' },
	]);
});

test('Google errors are reported and retried instead of being cached', async () => {
	const app = setup(async () => { throw new Error('Test quota exceeded'); });
	await app.press();
	await app.press();
	assert.equal(app.state.calls.length, 2);
	assert.equal(app.state.notices.length, 2);
	assert.ok(app.state.notices.every(notice => /Test quota exceeded/.test(notice.message)));
});

test('an older translation is aborted and cannot replace the latest notification or enter the cache', async () => {
	const first = Promise.withResolvers();
	const started = Promise.withResolvers();
	const app = setup(async source => {
		if (source === 'Hello' && app.state.calls.length === 1) {
			started.resolve();
			return first.promise;
		}
		return source === 'Goodbye' ? 'До свидания' : 'Новый перевод';
	});
	const old = app.press();
	await started.promise;
	app.state.text = 'Goodbye';
	await app.press();
	assert.equal(app.state.calls[0][1].signal.aborted, true);
	first.resolve('Устаревший перевод');
	await old;
	assert.deepEqual(app.state.notices.map(notice => notice.message), ['До свидания']);
	app.state.text = 'Hello';
	await app.press();
	assert.equal(app.state.calls.length, 3);
	assert.equal(app.state.notices.at(-1).message, 'Новый перевод');
});

test('an older Google rejection cannot show an error after a newer translation', async () => {
	const first = Promise.withResolvers();
	const started = Promise.withResolvers();
	const app = setup(async source => {
		if (source === 'Hello') { started.resolve(); return first.promise; }
		return 'Последний перевод';
	});
	const old = app.press();
	await started.promise;
	app.state.text = 'Latest selection';
	await app.press();
	first.reject(new Error('Stale request failed'));
	await old;
	assert.deepEqual(app.state.notices.map(notice => notice.message), ['Последний перевод']);
});

test('a slow earlier selection cannot trigger translation after a newer command', async () => {
	const first = Promise.withResolvers();
	const started = Promise.withResolvers();
	const app = setup();
	app.services.selection = async () => {
		if (app.state.reads.length === 1) { started.resolve(); return first.promise; }
		return [{ frameId: 0, result: 'Latest selection' }];
	};
	const old = app.press();
	await started.promise;
	await app.press();
	first.resolve([{ frameId: 0, result: 'Old selection' }]);
	await old;
	assert.deepEqual(app.state.calls.map(call => call[0]), ['Latest selection']);
	assert.equal(app.state.notices.length, 1);
});

test('a stale settings response cannot open Preferences after a newer command', async () => {
	const first = Promise.withResolvers();
	const started = Promise.withResolvers();
	const app = setup();
	app.services.settings = async () => {
		if (app.state.keys.length === 1) { started.resolve(); return first.promise; }
		return { ...app.settings };
	};
	const old = app.press();
	await started.promise;
	await app.press();
	first.resolve({});
	await old;
	assert.equal(app.state.opened, 0);
	assert.equal(app.state.calls.length, 1);
	assert.equal(app.state.notices.length, 1);
});

test('notification writes are serialized so the latest command remains visible', async () => {
	const release = Promise.withResolvers();
	const started = Promise.withResolvers();
	const app = setup(async source => `Перевод: ${source}`);
	let pending = 0;
	let maximumPending = 0;
	app.services.notify = async (id, notice) => {
		pending++;
		maximumPending = Math.max(maximumPending, pending);
		if (notice.message === 'Перевод: Hello') {
			started.resolve();
			await release.promise;
		}
		app.state.notices.push({ id, ...notice });
		pending--;
		return id;
	};
	const first = app.press();
	await started.promise;
	app.state.text = 'Latest selection';
	const second = app.press();
	await new Promise(resolve => setImmediate(resolve));
	release.resolve();
	await Promise.all([first, second]);
	assert.equal(maximumPending, 1);
	assert.equal(app.state.notices.at(-1).message, 'Перевод: Latest selection');
});

test('rejected notifications are handled and do not block a later command', async context => {
	context.mock.method(console, 'error', () => {});
	const app = setup();
	const notify = app.services.notify;
	app.services.notify = async () => { throw new Error('Notifications unavailable'); };
	await assert.doesNotReject(app.press());
	app.services.notify = notify;
	await app.press();
	assert.equal(app.state.notices.at(-1).message, 'Привет');
});
