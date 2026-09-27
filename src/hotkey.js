import { MAX_TEXT_LENGTH, normalizeText, translate } from './translate.js';
import { normalizeServerUrl, publishTranslation } from './bridge-client.js';
import { normalizeTargetLanguage } from './languages.js';

/** Read the selection in the focused frame, including ordinary text inputs. */
export function readSelection() {
	const active = document.activeElement;
	if (!document.hasFocus() || active?.tagName === 'IFRAME' || active?.type === 'password') return '';
	if (typeof active?.selectionStart === 'number') {
		return active.value.slice(active.selectionStart, active.selectionEnd);
	}
	return window.getSelection()?.toString() ?? '';
}

/** Register a Firefox shortcut that translates the selection on the paired phone. */
export function registerHotkey(browser, translateSelection = translate, publish = publishTranslation) {
	const cache = new Map();
	let cachedApiKey;
	let currentRequest;
	let publishQueue = Promise.resolve();

	/** Native notifications report setup or connection failures without changing a webpage. */
	async function notify(message) {
		await browser.notifications.create('phone-translation', {
			type: 'basic',
			iconUrl: browser.runtime.getURL('icons/translate.svg'),
			title: 'Translate in Context Menu',
			message,
		});
	}

	/** Serialize relay writes so an older result cannot overtake a newer selection. */
	function send(settings, result, request) {
		publishQueue = publishQueue.catch(() => {}).then(() => {
			if (currentRequest !== request) return;
			return publish(settings.phoneServerUrl, settings.phoneToken, result, request.signal);
		});
		return publishQueue;
	}

	/** Translate only in response to the explicit keyboard command. */
	async function onCommand(command) {
		if (command !== 'translate-on-phone') return;
		currentRequest?.abort();
		const request = new AbortController();
		currentRequest = request;
		try {
			const settings = await browser.storage.local.get(['apiKey', 'targetLanguage', 'phoneServerUrl', 'phoneToken']);
			if (currentRequest !== request) return;
			if (!normalizeText(settings.apiKey) || !settings.phoneServerUrl || !settings.phoneToken) {
				await browser.runtime.openOptionsPage();
				await notify('Save your Google API key, local phone server URL, and pairing token in Preferences.');
				return;
			}
			settings.phoneServerUrl = normalizeServerUrl(settings.phoneServerUrl);
			const targetLanguage = normalizeTargetLanguage(settings.targetLanguage);
			const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
			if (currentRequest !== request) return;
			if (!tab?.id || !/^https?:\/\//u.test(tab.url ?? '')) {
				throw new Error('Select text on an ordinary HTTP or HTTPS webpage first.');
			}
			const frames = await browser.scripting.executeScript({
				target: { tabId: tab.id, allFrames: true }, func: readSelection,
			});
			if (currentRequest !== request) return;
			const source = normalizeText(frames.find(frame => normalizeText(frame.result))?.result);
			if (!source) throw new Error('Select the text you want to translate before pressing the shortcut.');
			if ([...source].length > MAX_TEXT_LENGTH) throw new Error(`Select at most ${MAX_TEXT_LENGTH} characters.`);
			// Confirm the relay is reachable before making a potentially billable API request.
			await send(settings, { source, translation: '', error: '', targetLanguage }, request);
			if (currentRequest !== request) return;
			const apiKey = normalizeText(settings.apiKey);
			if (cachedApiKey !== apiKey) {
				cache.clear();
				cachedApiKey = apiKey;
			}
			const cacheKey = JSON.stringify([targetLanguage, source]);
			let translation = cache.get(cacheKey);
			try {
				if (!translation) {
					translation = await translateSelection(source, { apiKey, targetLanguage, signal: request.signal });
					if (currentRequest !== request) return;
					cache.set(cacheKey, translation);
				}
			} catch (error) {
				if (currentRequest !== request) return;
				await send(settings, { source, translation: '', error: error.message, targetLanguage }, request);
				throw error;
			}
			await send(settings, { source, translation, error: '', targetLanguage }, request);
		} catch (error) {
			if (currentRequest !== request) return;
			await notify(error instanceof TypeError
				? 'Could not connect. Check that the local phone server is running and its address is correct.'
				: error.message).catch(console.error);
		}
	}

	browser.commands.onCommand.addListener(onCommand);
}
