import { readSelection } from './hotkey.js';

/** Replace Yandex's source field and notify its page scripts without using the clipboard. */
export function pasteIntoYandex(text) {
	// Recheck the origin in case the tab navigated after the background found it.
	if (location.origin !== 'https://translate.yandex.ru') {
		return { error: 'The destination tab is no longer Yandex Translate.' };
	}
	const textarea = document.getElementById('textarea');
	if (!(textarea instanceof HTMLTextAreaElement) || textarea.disabled || textarea.readOnly) {
		return { error: 'Yandex Translate’s text field is not ready. Let the page load, then try again.' };
	}
	// Use the native setter so page frameworks also notice the following input event.
	const { set } = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
	set.call(textarea, text);
	textarea.dispatchEvent(new InputEvent('input', {
		bubbles: true, inputType: 'insertFromPaste', data: text,
	}));
	textarea.dispatchEvent(new Event('change', { bubbles: true }));
	return { ok: true };
}

/** Send the focused page's selection to an existing Yandex tab in this Firefox profile. */
export function registerYandexShortcut(browser) {
	let latestRequest = 0;
	let writes = Promise.resolve();

	/** Read before switching tabs, preferring a visible destination in another window. */
	async function onCommand(command) {
		if (command !== 'paste-in-yandex') return;
		const request = ++latestRequest;
		try {
			const [source] = await browser.tabs.query({ active: true, currentWindow: true });
			if (request !== latestRequest) return;
			if (!Number.isInteger(source?.id) || !/^https?:\/\//u.test(source.url ?? '')) {
				throw new Error('Select text on an ordinary HTTP or HTTPS webpage first.');
			}
			const frames = await browser.scripting.executeScript({
				target: { tabId: source.id, allFrames: true }, func: readSelection,
			});
			if (request !== latestRequest) return;
			const text = frames.find(frame => typeof frame.result === 'string' && frame.result.trim())?.result;
			if (!text) throw new Error('Select the text you want to send to Yandex Translate first.');
			const tabs = await browser.tabs.query({ url: 'https://translate.yandex.ru/*' });
			if (request !== latestRequest) return;
			const target = tabs.filter(tab => tab.id !== source.id).sort((a, b) =>
				Number(a.windowId === source.windowId) - Number(b.windowId === source.windowId)
				|| Number(b.active) - Number(a.active)
				|| (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)
				|| a.id - b.id
			)[0];
			if (!target) throw new Error('Open https://translate.yandex.ru/ in another Firefox window first.');
			// Finish an in-flight write before a newer one, so old text cannot arrive last.
			writes = writes.catch(() => {}).then(async () => {
				if (request !== latestRequest) return;
				const [injection] = await browser.scripting.executeScript({
					target: { tabId: target.id }, func: pasteIntoYandex, args: [text], injectImmediately: true,
				});
				if (request !== latestRequest) return;
				if (!injection?.result?.ok) {
					throw new Error(injection?.result?.error ?? 'Could not update Yandex Translate. Reload its tab and try again.');
				}
				if (!target.active) await browser.tabs.update(target.id, { active: true });
			});
			await writes;
		} catch (error) {
			if (request !== latestRequest) return;
			await browser.notifications.create('yandex-translation', {
				type: 'basic', iconUrl: browser.runtime.getURL('icons/translate.svg'),
				title: 'Translate in Context Menu', message: error.message,
			}).catch(console.error);
		}
	}

	browser.commands.onCommand.addListener(onCommand);
}
