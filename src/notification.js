import { readSelection } from './hotkey.js';
import { MAX_TEXT_LENGTH, normalizeText, translate } from './translate.js';

/** Translate the focused selection into Russian and show a native notification. */
export function registerNotificationShortcut(browser, translateSelection = translate) {
	const cache = new Map();
	let cachedApiKey;
	let currentRequest;
	let notificationQueue = Promise.resolve();

	/** Keep notification writes in order and discard superseded results. */
	function notify(message, request, title = 'Перевод на русский') {
		notificationQueue = notificationQueue.then(() => {
			if (currentRequest !== request) return;
			return browser.notifications.create('selection-translation', {
				type: 'basic',
				iconUrl: browser.runtime.getURL('icons/translate.svg'),
				title,
				message,
			});
		}).catch(console.error);
		return notificationQueue;
	}

	/** Read page content only after the user invokes this command. */
	async function onCommand(command) {
		if (command !== 'translate-in-notification') return;
		currentRequest?.abort();
		const request = new AbortController();
		currentRequest = request;
		// Another command can start during any await, even if the old fetch is aborted.
		try {
			const settings = await browser.storage.local.get('apiKey');
			if (currentRequest !== request) return;
			const apiKey = normalizeText(settings.apiKey);
			if (cachedApiKey !== apiKey) {
				cache.clear();
				cachedApiKey = apiKey;
			}
			if (!apiKey) {
				await browser.runtime.openOptionsPage();
				throw new Error('Save your Google Cloud Translation API key in Preferences.');
			}
			const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
			if (currentRequest !== request) return;
			if (!Number.isInteger(tab?.id) || !/^https?:\/\//u.test(tab.url ?? '')) {
				throw new Error('Select text on an ordinary HTTP or HTTPS webpage first.');
			}
			const frames = await browser.scripting.executeScript({
				target: { tabId: tab.id, allFrames: true }, func: readSelection,
			});
			if (currentRequest !== request) return;
			const source = normalizeText(frames.find(frame => normalizeText(frame.result))?.result);
			if (!source) throw new Error('Select the text you want to translate before pressing the shortcut.');
			if ([...source].length > MAX_TEXT_LENGTH) throw new Error(`Select at most ${MAX_TEXT_LENGTH} characters.`);
			let translation = cache.get(source);
			if (!translation) {
				translation = await translateSelection(source, { apiKey, signal: request.signal });
				if (currentRequest !== request) return;
				cache.set(source, translation);
			}
			// A loading notification followed by a result can suppress both in Firefox.
			await notify(translation, request);
		} catch (error) {
			if (currentRequest !== request) return;
			await notify(error.message, request, 'Translate in Context Menu');
		}
	}

	browser.commands.onCommand.addListener(onCommand);
}
