import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_TEXT_LENGTH, menuTitle, normalizeText, translate } from '../src/translate.js';

const API_KEY = 'test-api-key';

/** Create a minimal successful Google response without making network requests. */
function translatedResponse(translation = 'Привет') {
	return {
		ok: true,
		status: 200,
		json: async () => ({ data: { translations: [{ translatedText: translation }] } }),
	};
}

test('normalization trims the selection and preserves internal whitespace', () => {
	assert.equal(normalizeText(' \tHello  world\nsecond line\n'), 'Hello  world\nsecond line');
	assert.equal(normalizeText(undefined), '');
});

test('translation posts text to the official API with the key only in a header', async context => {
	const fetchMock = context.mock.method(globalThis, 'fetch', async () => translatedResponse());
	const text = 'Hello & goodbye?\nПривет + мир 😃';
	assert.equal(await translate(` ${text} `, { apiKey: ` ${API_KEY} ` }), 'Привет');
	assert.equal(fetchMock.mock.callCount(), 1);
	const [request, options] = fetchMock.mock.calls[0].arguments;
	const url = new URL(request);
	assert.equal(url.href, 'https://translation.googleapis.com/language/translate/v2');
	assert.equal(options.method, 'POST');
	assert.deepEqual(options.headers, {
		'Content-Type': 'application/json; charset=utf-8',
		'X-goog-api-key': API_KEY,
	});
	assert.deepEqual(JSON.parse(options.body), {
		q: text, target: 'ru', format: 'text', model: 'nmt',
	});
	assert.equal(options.credentials, 'omit');
	assert.equal(options.cache, 'no-store');
	assert.equal(options.referrerPolicy, 'no-referrer');
	assert.ok(options.signal instanceof AbortSignal);
});

test('translation reads the official response and preserves literal text', async context => {
	context.mock.method(globalThis, 'fetch', async () => translatedResponse('Привет, мир &amp; <все>!'));
	assert.equal(await translate('Hello, world &amp; <all>!', { apiKey: API_KEY }), 'Привет, мир &amp; <все>!');
});

test('translation sends the selected language and preserves canonical regional codes', async context => {
	const requests = [];
	context.mock.method(globalThis, 'fetch', async (_url, options) => {
		requests.push(JSON.parse(options.body));
		return translatedResponse('Translation');
	});
	for (const targetLanguage of ['fr', 'zh-TW', 'mni-Mtei']) {
		await translate('Hello', { apiKey: API_KEY, targetLanguage });
		assert.equal(requests.at(-1).target, targetLanguage);
	}
});

test('a missing or blank API key fails before sending a request', async context => {
	const fetchMock = context.mock.method(globalThis, 'fetch', async () => translatedResponse());
	await assert.rejects(translate('Hello'), /Set your Google Cloud API key in Preferences/);
	await assert.rejects(translate('Hello', { apiKey: ' \t\n' }), /Set your Google Cloud API key in Preferences/);
	assert.equal(fetchMock.mock.callCount(), 0);
});

test('empty and oversized selections fail before sending a request', async context => {
	const fetchMock = context.mock.method(globalThis, 'fetch', async () => translatedResponse());
	await assert.rejects(translate(' \n\t ', { apiKey: API_KEY }), /Select text/);
	await assert.rejects(translate('😀'.repeat(MAX_TEXT_LENGTH + 1), { apiKey: API_KEY }), /maximum 5000 characters/);
	assert.equal(fetchMock.mock.callCount(), 0);
});

test('the length limit counts Unicode code points instead of UTF-16 units', async context => {
	context.mock.method(globalThis, 'fetch', async () => translatedResponse());
	assert.equal(await translate('😀'.repeat(MAX_TEXT_LENGTH), { apiKey: API_KEY }), 'Привет');
});

test('menu titles contain only the translation with whitespace normalized and Firefox markers escaped', () => {
	assert.equal(menuTitle(' \nТы & я\t %s\n  вместе '), 'Ты && я %\u200bs вместе');
});

test('menu titles truncate at Unicode boundaries and add an ellipsis only when needed', () => {
	assert.equal(menuTitle('😀'.repeat(110)), '😀'.repeat(110));
	assert.equal(menuTitle('😀'.repeat(111)), `${'😀'.repeat(110)}…`);
});

test('HTTP rate limiting explains the Google Cloud quota', async context => {
	context.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 429 }));
	await assert.rejects(translate('Hello', { apiKey: API_KEY }), /Google Cloud quota exceeded/);
});

test('HTTP 400 and 401 explain invalid keys without exposing the service response', async context => {
	const fetchMock = context.mock.method(globalThis, 'fetch', async () => translatedResponse());
	for (const status of [400, 401]) {
		const json = context.mock.fn(async () => ({ error: { message: API_KEY } }));
		fetchMock.mock.mockImplementation(async () => ({ ok: false, status, json }));
		await assert.rejects(translate('Hello', { apiKey: API_KEY }), error => {
			assert.match(error.message, /Check your API key in Preferences/);
			assert.match(error.message, new RegExp(`HTTP ${status}`));
			assert.ok(!error.message.includes(API_KEY));
			return true;
		});
		assert.equal(json.mock.callCount(), 0);
	}
});

test('HTTP 403 explains API enablement, billing, and the documented quota failures', async context => {
	context.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }));
	await assert.rejects(translate('Hello', { apiKey: API_KEY }), /Check your API key, quotas, Cloud Translation API, and billing/);
});

test('other HTTP failures include their status', async context => {
	context.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
	await assert.rejects(translate('Hello', { apiKey: API_KEY }), /Google Translate is unavailable \(HTTP 503\)/);
});

test('malformed response structures and empty translations are rejected', async context => {
	const payloads = [
		null, {}, [], { data: null }, { data: {} },
		{ data: { translations: null } }, { data: { translations: {} } },
		{ data: { translations: [] } }, { data: { translations: [null] } },
		{ data: { translations: [{}] } }, { data: { translations: [{ translatedText: 1 }] } },
		{ data: { translations: [{ translatedText: '' }] } },
		{ data: { translations: [{ translatedText: ' \n ' }] } },
		{ data: { translations: [{ translatedText: 'one' }, { translatedText: 'two' }] } },
	];
	const fetchMock = context.mock.method(globalThis, 'fetch', async () => translatedResponse());
	for (const payload of payloads) {
		fetchMock.mock.mockImplementation(async () => ({
			...translatedResponse(), json: async () => payload,
		}));
		await assert.rejects(translate('Hello', { apiKey: API_KEY }), /Could not read the Google Translate response/);
	}
});

test('invalid JSON has a response error rather than a network error', async context => {
	context.mock.method(globalThis, 'fetch', async () => ({
		...translatedResponse(),
		json: async () => { throw new SyntaxError('Invalid JSON'); },
	}));
	await assert.rejects(translate('Hello', { apiKey: API_KEY }), /Could not read the Google Translate response/);
});

test('network failures include a useful error and retain their cause', async context => {
	const cause = new TypeError('Failed to fetch');
	context.mock.method(globalThis, 'fetch', async () => { throw cause; });
	await assert.rejects(translate('Hello', { apiKey: API_KEY }), error => {
		assert.match(error.message, /Check your connection/);
		assert.equal(error.cause, cause);
		return true;
	});
});

test('an already cancelled request never fetches and preserves the cancellation reason', async context => {
	const fetchMock = context.mock.method(globalThis, 'fetch', async () => translatedResponse());
	const controller = new AbortController();
	const reason = new Error('Menu closed');
	controller.abort(reason);
	await assert.rejects(translate('Hello', { apiKey: API_KEY, signal: controller.signal }), error => error === reason);
	assert.equal(fetchMock.mock.callCount(), 0);
});

test('cancelling a running request aborts fetch and preserves the cancellation reason', async context => {
	context.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
		signal.addEventListener('abort', () => reject(signal.reason), { once: true });
	}));
	const controller = new AbortController();
	const pending = translate('Hello', { apiKey: API_KEY, signal: controller.signal });
	controller.abort();
	await assert.rejects(pending, error => error === controller.signal.reason);
});

test('requests time out after ten seconds with a readable error', async context => {
	const controller = new AbortController();
	const timeoutMock = context.mock.method(AbortSignal, 'timeout', () => controller.signal);
	context.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
		signal.addEventListener('abort', () => reject(signal.reason), { once: true });
	}));
	const pending = translate('Hello', { apiKey: API_KEY });
	controller.abort(new DOMException('Request timed out', 'TimeoutError'));
	await assert.rejects(pending, /did not respond within 10 seconds/);
	assert.deepEqual(timeoutMock.mock.calls[0].arguments, [10_000]);
});

test('cancellation while reading the response body preserves the caller reason', async context => {
	const controller = new AbortController();
	context.mock.method(globalThis, 'fetch', async () => ({
		...translatedResponse(),
		json: async () => {
			controller.abort();
			throw controller.signal.reason;
		},
	}));
	await assert.rejects(translate('Hello', { apiKey: API_KEY, signal: controller.signal }), error => error === controller.signal.reason);
});
