import assert from 'node:assert/strict';
import test from 'node:test';
import { registerMenu } from '../src/menu.js';

const MENU_ID = 'translate-to-russian';

/** Create an asynchronous WebExtension event with observable listeners. */
function event() {
	const listeners = [];
	return {
		addListener: listener => listeners.push(listener),
		fire: (...args) => Promise.all(listeners.map(listener => listener(...args))),
	};
}

/** Mock browser menu behavior without network access or a running browser. */
function setup(translateSelection) {
	const updates = [];
	const created = [];
	const tabs = [];
	const stats = { refreshes: 0, removals: 0 };
	const settings = { apiKey: 'test-api-key' };
	const browser = {
		menus: {
			onShown: event(), onHidden: event(), onClicked: event(),
			create: properties => created.push(properties),
			removeAll: async () => { stats.removals++; },
			update: async (id, properties) => {
				assert.equal(id, MENU_ID);
				updates.push(properties);
			},
			refresh: async () => { stats.refreshes++; },
		},
		runtime: {
			onInstalled: event(), onStartup: event(),
		},
		tabs: { create: async properties => { tabs.push(properties); } },
		storage: { local: { get: async () => ({ ...settings }) } },
	};
	registerMenu(browser, translateSelection);
	return {
		browser, updates, created, tabs, stats, settings,
		show: selectionText => browser.menus.onShown.fire({ menuIds: [MENU_ID], selectionText }),
		hide: () => browser.menus.onHidden.fire(),
	};
}

/** Expose a promise's settlement to reproduce out-of-order requests deterministically. */
function deferred() {
	return Promise.withResolvers();
}

test('installation and browser startup create one enabled selection menu', async () => {
	const { browser, created, stats } = setup();
	assert.equal(created.length, 0, 'waking an event page must not recreate persistent menus');
	await browser.runtime.onInstalled.fire();
	await browser.runtime.onStartup.fire();
	assert.equal(stats.removals, 2);
	assert.equal(created.length, 2);
	assert.deepEqual(created[0], {
		id: MENU_ID,
		title: 'Перевести на русский',
		contexts: ['selection'],
		documentUrlPatterns: ['http://*/*', 'https://*/*'],
		enabled: true,
	});
});

test('opening a menu shows loading then refreshes it with the translation', async () => {
	const app = setup(async (source, { apiKey }) => {
		assert.equal(source, 'Hello');
		assert.equal(apiKey, 'test-api-key');
		assert.equal(app.updates.at(-1).title, 'Переводим…');
		assert.equal(app.updates.at(-1).enabled, true);
		return 'Привет';
	});
	await app.show(' Hello ');
	assert.deepEqual(app.updates.map(item => item.title), ['Переводим…', 'Привет']);
	assert.equal(app.updates.at(-1).enabled, true);
	assert.equal(app.stats.refreshes, 2);
	await app.hide();
	assert.equal(app.updates.at(-1).title, 'Перевести на русский');
	assert.equal(app.updates.at(-1).enabled, true);
	assert.equal(app.stats.refreshes, 2, 'a hidden menu is not refreshed');
});

test('missing API key points to preferences and still opens Google Translate on click', async () => {
	const app = setup(() => assert.fail('No request without an API key'));
	delete app.settings.apiKey;
	await app.show('Hello');
	assert.deepEqual(app.updates.at(-1), {
		title: 'Укажите API-ключ в настройках расширения', enabled: true,
	});
	await app.browser.menus.onClicked.fire({ menuItemId: MENU_ID, selectionText: 'Hello' });
	assert.deepEqual(app.tabs, [{ url: 'https://translate.google.com/?sl=auto&tl=ru&text=Hello&op=translate' }]);
	await app.hide();
	assert.equal(app.updates.at(-1).enabled, true);
});

test('clicking uses the click event selection and safely encodes the Google Translate URL', async () => {
	const app = setup(async () => 'Старый перевод');
	await app.show('Old selection');
	await app.hide();
	const selectionText = '  Привет & goodbye? + # %s\n😀  ';
	await app.browser.menus.onClicked.fire({ menuItemId: MENU_ID, selectionText });
	assert.equal(app.tabs.length, 1);
	const url = new URL(app.tabs[0].url);
	assert.equal(url.origin, 'https://translate.google.com');
	assert.equal(url.pathname, '/');
	assert.equal(url.hash, '');
	assert.deepEqual(Object.fromEntries(url.searchParams), {
		sl: 'auto', tl: 'ru', text: selectionText, op: 'translate',
	});
});

test('clicks for other menu items or missing selections do not open a tab', async () => {
	const app = setup(() => assert.fail('Clicking does not use the API'));
	await app.browser.menus.onClicked.fire({ menuItemId: 'another-extension', selectionText: 'Hello' });
	for (const selectionText of [undefined, '', ' \n\t ']) {
		await app.browser.menus.onClicked.fire({ menuItemId: MENU_ID, selectionText });
	}
	assert.equal(app.tabs.length, 0);
});

test('clicking while a translation is loading opens Google Translate immediately', async () => {
	const started = deferred();
	const reply = deferred();
	const app = setup(() => { started.resolve(); return reply.promise; });
	const opening = app.show('Hello');
	await started.promise;
	assert.deepEqual(app.updates.at(-1), { title: 'Переводим…', enabled: true });
	await app.browser.menus.onClicked.fire({ menuItemId: MENU_ID, selectionText: 'Hello' });
	assert.equal(new URL(app.tabs[0].url).searchParams.get('text'), 'Hello');
	reply.resolve('Привет');
	await opening;
});

test('the saved key is trimmed and read again for the next menu opening', async () => {
	const keys = [];
	const app = setup(async (_source, { apiKey }) => { keys.push(apiKey); return 'Привет'; });
	app.settings.apiKey = ' first-key ';
	await app.show('Hello');
	await app.hide();
	app.settings.apiKey = 'second-key';
	await app.show('Hello');
	assert.deepEqual(keys, ['first-key', 'second-key'], 'a changed key clears the old cache');
	assert.equal(app.updates.at(-1).enabled, true);
});

test('removing the key prevents previously cached translations from being shown', async () => {
	let calls = 0;
	const app = setup(async () => { calls++; return 'Привет'; });
	await app.show('Hello');
	await app.hide();
	app.settings.apiKey = '';
	await app.show('Hello');
	assert.equal(calls, 1);
	assert.match(app.updates.at(-1).title, /Укажите API-ключ/);
	assert.equal(app.updates.at(-1).enabled, true);
});

test('closing the menu while settings load prevents a translation request', async context => {
	const pending = deferred();
	const app = setup(() => assert.fail('No request for a closed menu'));
	context.mock.method(app.browser.storage.local, 'get', () => pending.promise);
	const opening = app.show('Hello');
	await app.hide();
	pending.resolve({ apiKey: 'test-api-key' });
	await opening;
	assert.deepEqual(app.updates.map(item => item.title), ['Перевести на русский']);
});

test('menus without the extension item never translate', async () => {
	const app = setup(() => assert.fail('No request expected'));
	await app.browser.menus.onShown.fire({ menuIds: [], selectionText: 'Hello' });
	assert.equal(app.updates.length, 0);
});

test('missing host permission or empty selection does not send a request', async () => {
	const app = setup(() => assert.fail('No request expected'));
	await app.show(undefined);
	await app.show(' \n ');
	assert.equal(app.updates.length, 2);
	assert.match(app.updates[0].title, /Нет доступа к выделению/);
	assert.ok(app.updates.every(item => item.enabled));
});

test('reopening the same selection uses its cached translation', async () => {
	let calls = 0;
	const app = setup(async () => { calls++; return 'Привет'; });
	await app.show('Hello');
	await app.hide();
	await app.show(' Hello ');
	assert.equal(calls, 1);
	assert.equal(app.updates.at(-1).title, 'Привет');
	assert.equal(app.updates.at(-1).enabled, true);
});

test('the in-memory cache keeps earlier translations beyond one hundred entries', async () => {
	let calls = 0;
	const app = setup(async source => { calls++; return source; });
	for (let index = 0; index <= 100; index++) await app.show(`Text ${index}`);
	await app.show('Text 100');
	assert.equal(calls, 101);
	await app.show('Text 0');
	assert.equal(calls, 101);
});

test('errors appear in the menu and are retried rather than cached', async () => {
	let calls = 0;
	const app = setup(async () => {
		if (calls++ === 0) throw new Error('Слишком много запросов. Попробуйте позже.');
		return 'Привет';
	});
	await app.show('Hello');
	assert.match(app.updates.at(-1).title, /Слишком много запросов/);
	assert.equal(app.updates.at(-1).enabled, true);
	await app.browser.menus.onClicked.fire({ menuItemId: MENU_ID, selectionText: 'Hello' });
	assert.equal(new URL(app.tabs[0].url).searchParams.get('text'), 'Hello');
	await app.show('Hello');
	assert.equal(calls, 2);
	assert.equal(app.updates.at(-1).title, 'Привет');
});

test('closing the menu aborts work and discards a late response', async () => {
	const started = deferred();
	const reply = deferred();
	let signal;
	const app = setup((_source, options) => {
		signal = options.signal;
		started.resolve();
		return reply.promise;
	});
	const opening = app.show('Hello');
	await started.promise;
	await app.hide();
	assert.ok(signal.aborted);
	reply.resolve('Привет');
	await opening;
	assert.deepEqual(app.updates.map(item => item.title), ['Переводим…', 'Перевести на русский']);
});

test('a stale response cannot replace a newer selection in another menu', async () => {
	const started = deferred();
	const reply = deferred();
	const app = setup(source => {
		if (source === 'Hello') {
			started.resolve();
			return reply.promise;
		}
		return Promise.resolve('До свидания');
	});
	const oldOpening = app.show('Hello');
	await started.promise;
	await app.show('Goodbye');
	reply.resolve('Привет');
	await oldOpening;
	assert.equal(app.updates.at(-1).title, 'До свидания');
	assert.ok(!app.updates.some(item => item.title === 'Привет'));
});

test('a failure from an obsolete request cannot overwrite a new result', async () => {
	const started = deferred();
	const reply = deferred();
	const app = setup(source => {
		if (source === 'Hello') {
			started.resolve();
			return reply.promise;
		}
		return Promise.resolve('До свидания');
	});
	const oldOpening = app.show('Hello');
	await started.promise;
	await app.show('Goodbye');
	reply.reject(new Error('Old failure'));
	await oldOpening;
	assert.equal(app.updates.at(-1).title, 'До свидания');
});

test('closing while the loading label updates prevents both fetch and refresh', async context => {
	const started = deferred();
	const finished = deferred();
	const app = setup(() => assert.fail('No request expected'));
	context.mock.method(app.browser.menus, 'update', async (_id, { title }) => {
		if (title === 'Переводим…') {
			started.resolve();
			await finished.promise;
		}
	});
	const opening = app.show('Hello');
	await started.promise;
	await app.hide();
	finished.resolve();
	await opening;
	assert.equal(app.stats.refreshes, 0);
});

test('closing while the result label updates prevents refreshing a different menu', async context => {
	const started = deferred();
	const finished = deferred();
	const app = setup(async () => 'Привет');
	context.mock.method(app.browser.menus, 'update', async (_id, { title }) => {
		if (title === 'Привет') {
			started.resolve();
			await finished.promise;
		}
	});
	const opening = app.show('Hello');
	await started.promise;
	await app.hide();
	finished.resolve();
	await opening;
	assert.equal(app.stats.refreshes, 1);
});

test('the default translator connects the selection to the menu with mock Google data', async context => {
	context.mock.method(globalThis, 'fetch', async (request, options) => {
		assert.equal(new URL(request).href, 'https://translation.googleapis.com/language/translate/v2');
		assert.equal(JSON.parse(options.body).q, 'Hello, world!');
		assert.equal(new Headers(options.headers).get('x-goog-api-key'), 'test-api-key');
		return new Response(JSON.stringify({ data: { translations: [{ translatedText: 'Привет, мир!' }] } }));
	});
	const app = setup();
	await app.show('Hello, world!');
	assert.equal(app.updates.at(-1).title, 'Привет, мир!');
});
