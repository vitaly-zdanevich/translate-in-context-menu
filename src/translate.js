/** Maximum selection length, measured in Unicode code points. */
export const MAX_TEXT_LENGTH = 5000;

const REQUEST_TIMEOUT_MS = 10_000;
const MENU_TEXT_LENGTH = 110;
const INVALID_RESPONSE_MESSAGE = 'Не удалось прочитать ответ Google Translate. Попробуйте ещё раз.';

/**
 * Remove surrounding whitespace while preserving the selected text's layout.
 * @param {string} text Selected text.
 * @returns {string} The trimmed selection, or an empty string for missing text.
 */
export function normalizeText(text) {
	return typeof text === 'string' ? text.trim() : '';
}

/**
 * Format a concise menu label without Firefox access keys or selection markers.
 * The translated portion is limited to 110 Unicode code points before escaping.
 * @param {string} translation Translated text.
 * @returns {string} A title suitable for browser.menus.update().
 */
export function menuTitle(translation) {
	const characters = [...normalizeText(translation).replace(/\s+/gu, ' ')];
	const title = characters.length > MENU_TEXT_LENGTH
		? `${characters.slice(0, MENU_TEXT_LENGTH).join('')}…`
		: characters.join('');

	return title.replaceAll('&', '&&').replaceAll('%s', '%\u200bs');
}

/**
 * Preserve caller cancellation and distinguish timeouts from network failures.
 * @param {unknown} cause The failed request's error.
 * @param {AbortSignal | undefined} signal Caller cancellation signal.
 * @param {AbortSignal} timeoutSignal The request's timeout signal.
 * @returns {unknown} The original cancellation reason or a readable error.
 */
function requestError(cause, signal, timeoutSignal) {
	if (signal?.aborted) {
		return signal.reason;
	}

	if (timeoutSignal.aborted) {
		return new Error('Google Translate не ответил за 10 секунд. Попробуйте ещё раз.', { cause });
	}

	return new Error('Не удалось подключиться к Google Translate. Проверьте соединение.', { cause });
}

/**
 * Translate a selection into Russian with the official Google Cloud Basic API.
 * The key goes in a request header and selected text goes in the JSON body.
 * Cookies, referrer information, and browser caching are disabled.
 * @param {string} text Selected text; at most 5000 Unicode code points.
 * @param {{ apiKey?: string, signal?: AbortSignal }} [options] API key and optional cancellation.
 * @returns {Promise<string>} Plain translated text.
 * @throws {Error} For invalid text, missing keys, HTTP errors, malformed responses, or timeouts.
 */
export async function translate(text, { apiKey, signal } = {}) {
	const selection = normalizeText(text);
	if (!selection) {
		throw new Error('Выделите текст для перевода.');
	}

	if ([...selection].length > MAX_TEXT_LENGTH) {
		throw new Error(`Текст слишком длинный (максимум ${MAX_TEXT_LENGTH} символов).`);
	}

	const key = normalizeText(apiKey);
	if (!key) {
		throw new Error('Добавьте API-ключ Google Cloud в настройках расширения.');
	}

	signal?.throwIfAborted();
	const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	let response;
	try {
		response = await fetch('https://translation.googleapis.com/language/translate/v2', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				'X-goog-api-key': key,
			},
			body: JSON.stringify({ q: selection, target: 'ru', format: 'text', model: 'nmt' }),
			signal: requestSignal,
			credentials: 'omit',
			cache: 'no-store',
			referrerPolicy: 'no-referrer',
		});
	} catch (cause) {
		throw requestError(cause, signal, timeoutSignal);
	}

	if (response.status === 400 || response.status === 401) {
		throw new Error(`Google Cloud отклонил запрос (HTTP ${response.status}). Проверьте API-ключ в настройках.`);
	}

	if (response.status === 403) {
		throw new Error('Доступ запрещён (HTTP 403). Проверьте API-ключ, квоты, Cloud Translation API и биллинг.');
	}

	if (response.status === 429) {
		throw new Error('Квота Google Cloud исчерпана. Проверьте лимиты или попробуйте позже.');
	}

	if (!response.ok) {
		throw new Error(`Google Translate недоступен (HTTP ${response.status}). Попробуйте позже.`);
	}

	let payload;
	try {
		payload = await response.json();
	} catch (cause) {
		if (requestSignal.aborted) {
			throw requestError(cause, signal, timeoutSignal);
		}
		throw new Error(INVALID_RESPONSE_MESSAGE, { cause });
	}

	const translations = payload?.data?.translations;
	if (!Array.isArray(translations) || translations.length !== 1
		|| typeof translations[0]?.translatedText !== 'string') {
		throw new Error(INVALID_RESPONSE_MESSAGE);
	}

	const translation = translations[0].translatedText.trim();
	if (!translation) {
		throw new Error(INVALID_RESPONSE_MESSAGE);
	}

	return translation;
}
