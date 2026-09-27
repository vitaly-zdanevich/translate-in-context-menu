const originalFetch = globalThis.fetch.bind(globalThis);
const originalNotify = browser.notifications.create.bind(browser.notifications);

/** Retain failure diagnostics in the disposable test profile only. */
browser.commands.onCommand.addListener(command => browser.storage.session.set({ e2eLastCommand: command }));
browser.notifications.onShown.addListener(id => browser.storage.session.set({ e2eNotificationShown: id }));
browser.notifications.create = async (...arguments_) => {
	const options = arguments_.at(-1);
	await browser.storage.session.set({
		e2eNotification: options.message,
		e2eNotificationOptions: options,
	});
	const id = await originalNotify(...arguments_);
	await browser.storage.session.set({ e2eNotificationAccepted: id });
	return id;
};

/** Mock Google only; relay requests exercise Firefox's real HTTP stack and CSP. */
globalThis.fetch = async (input, options = {}) => {
	const url = new URL(input);
	if (url.protocol === 'http:' && url.pathname === '/api/translation') {
		await browser.storage.session.set({ e2eRelayUrl: url.href });
		return originalFetch(input, options);
	}
	const { e2eRequestCount = 0 } = await browser.storage.session.get('e2eRequestCount');
	await browser.storage.session.set({ e2eRequestCount: e2eRequestCount + 1 });
	const headers = new Headers(options.headers);
	const body = JSON.parse(options.body);
	if (url.href !== 'https://translation.googleapis.com/language/translate/v2'
		|| options.method !== 'POST'
		|| headers.get('X-Goog-Api-Key') !== 'test-api-key'
		|| headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json'
		|| body.target !== 'ru'
		|| body.format !== 'text'
		|| body.model !== 'nmt') {
		throw new Error(`Unexpected translation request: ${url}`);
	}

	const source = body.q;
	await new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, source === 'Slow translation' ? 1400 : 700);
		// Deliberately ignore cancellation once to exercise stale-response handling.
		if (source !== 'Slow translation') {
			options.signal?.addEventListener('abort', () => {
				clearTimeout(timer);
				reject(new DOMException('Aborted', 'AbortError'));
			}, { once: true });
		}
	});

	if (source === 'Simulated network failure') {
		throw new TypeError('Simulated network failure');
	}
	const translations = {
		'Hello, world!': 'Привет, мир!',
		'Good morning!': 'Доброе утро!',
		'Slow translation': 'Медленный перевод',
	};
	if (!(source in translations)) {
		throw new Error(`Unexpected selected text: ${source}`);
	}
	return new Response(JSON.stringify({
		data: { translations: [{ translatedText: translations[source] }] },
	}), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
};
