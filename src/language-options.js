import { LANGUAGES, normalizeTargetLanguage } from './languages.js';

const select = document.querySelector('#target-language');
const status = document.querySelector('#language-status');
let savedLanguage = 'ru';

/** Populate the native dropdown without contacting Google or changing saved settings. */
async function loadLanguage() {
	select.replaceChildren(...[...LANGUAGES].map(([code, name]) => new Option(name, code)));
	try {
		const { targetLanguage } = await browser.storage.local.get('targetLanguage');
		savedLanguage = normalizeTargetLanguage(targetLanguage);
	} catch {
		status.textContent = 'Could not load the target language. Try reopening Preferences.';
	} finally {
		select.value = savedLanguage;
		select.disabled = false;
	}
}

/** Save only the target language; restore the previous choice if storage fails. */
async function saveLanguage() {
	select.disabled = true;
	status.textContent = '';
	const targetLanguage = normalizeTargetLanguage(select.value);
	try {
		await browser.storage.local.set({ targetLanguage });
		savedLanguage = targetLanguage;
		status.textContent = 'Target language saved.';
	} catch {
		status.textContent = 'Could not save the target language. Please try again.';
	} finally {
		select.value = savedLanguage;
		select.disabled = false;
	}
}

select.addEventListener('change', saveLanguage);
loadLanguage();
