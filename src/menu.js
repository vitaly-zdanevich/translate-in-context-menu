import { menuTitle, normalizeText, translate } from './translate.js';
import { normalizeTargetLanguage } from './languages.js';

const MENU_ID = 'translate-to-russian';
const DEFAULT_TITLE = 'Translate selection';

/**
 * Register the native Firefox menu and its event handlers.
 * Translations stay in memory until the event page is unloaded; no history is saved.
 * @param {object} browser Firefox WebExtension APIs.
 * @param {Function} translateSelection Translation function, replaceable in tests.
 */
export function registerMenu(browser, translateSelection = translate) {
	const cache = new Map();
	let currentRequest;
	let cachedApiKey;

	/** Update only the menu opening that owns this request, including after awaits. */
	async function update(request, title) {
		if (currentRequest !== request) return;
		await browser.menus.update(MENU_ID, { title, enabled: true });
		if (currentRequest === request) await browser.menus.refresh();
	}

	/** Abort work when the user closes the menu or opens a different one. */
	function cancel() {
		currentRequest?.abort();
		currentRequest = undefined;
	}

	/** Reset the saved label so the next opening never starts with an old translation. */
	async function onHidden() {
		cancel();
		await browser.menus.update(MENU_ID, { title: DEFAULT_TITLE, enabled: true });
	}

	/** Translate only the selection supplied by a visible native context menu. */
	async function onShown(info) {
		cancel();
		if (!info.menuIds.includes(MENU_ID)) return;

		const request = new AbortController();
		currentRequest = request;
		try {
			const source = normalizeText(info.selectionText);
			if (!source) {
				await update(request, 'Cannot access the selection. Check website permissions.');
				return;
			}

			// Read on each opening so saved or removed keys take effect immediately.
			const settings = await browser.storage.local.get(['apiKey', 'targetLanguage']);
			if (currentRequest !== request) return;
			const apiKey = normalizeText(settings.apiKey);
			if (apiKey !== cachedApiKey) {
				cache.clear();
				cachedApiKey = apiKey;
			}
			if (!apiKey) {
				await update(request, 'Set your API key in Preferences.');
				return;
			}

			const targetLanguage = normalizeTargetLanguage(settings.targetLanguage);
			const cacheKey = JSON.stringify([targetLanguage, source]);
			let translation = cache.get(cacheKey);
			if (!translation) {
				await update(request, 'Translating…');
				if (currentRequest !== request) return;
				translation = await translateSelection(source, { apiKey, targetLanguage, signal: request.signal });
				if (currentRequest !== request) return;
				cache.set(cacheKey, translation);
			}

			await update(request, menuTitle(translation));
		} catch (error) {
			if (currentRequest !== request) return;
			await update(request, error.message).catch(console.error);
		}
	}

	/** Open Google Translate for the clicked selection, regardless of API progress. */
	async function onClicked(info) {
		if (info.menuItemId !== MENU_ID || !normalizeText(info.selectionText)) return;
		const { targetLanguage } = await browser.storage.local.get('targetLanguage');
		const url = new URL('https://translate.google.com/');
		url.search = new URLSearchParams({
			sl: 'auto', tl: normalizeTargetLanguage(targetLanguage), text: info.selectionText, op: 'translate',
		}).toString();
		return browser.tabs.create({ url: url.href });
	}

	/** Menu definitions persist while an MV3 background page sleeps. */
	async function createMenu() {
		await browser.menus.removeAll();
		browser.menus.create({
			id: MENU_ID,
			title: DEFAULT_TITLE,
			contexts: ['selection'],
			documentUrlPatterns: ['http://*/*', 'https://*/*'],
			enabled: true,
		});
	}

	browser.runtime.onInstalled.addListener(createMenu);
	browser.runtime.onStartup.addListener(createMenu);
	browser.menus.onShown.addListener(onShown);
	browser.menus.onHidden.addListener(onHidden);
	browser.menus.onClicked.addListener(onClicked);
}
