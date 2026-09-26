import { normalizeServerUrl } from './bridge-client.js';

const form = document.querySelector('#phone-settings');
const controls = document.querySelector('#phone-controls');
const urlInput = document.querySelector('#phone-url');
const tokenInput = document.querySelector('#phone-token');
const status = document.querySelector('#phone-status');

/** Load the local relay settings separately from the Google API credential. */
async function load() {
	try {
		const settings = await browser.storage.local.get(['phoneServerUrl', 'phoneToken']);
		urlInput.value = settings.phoneServerUrl ?? '';
		tokenInput.value = settings.phoneToken ?? '';
	} catch {
		status.textContent = 'Could not load phone settings. Reopen Preferences to retry.';
	} finally {
		controls.disabled = false;
	}
}

/** Store the LAN address and pairing token without sending a test translation. */
async function save(event) {
	event.preventDefault();
	controls.disabled = true;
	try {
		const phoneServerUrl = normalizeServerUrl(urlInput.value.trim());
		const phoneToken = tokenInput.value.trim();
		if (!/^[a-f0-9]{64}$/iu.test(phoneToken)) throw new Error('Paste the 64-character pairing token printed by the local server.');
		await browser.storage.local.set({ phoneServerUrl, phoneToken });
		urlInput.value = phoneServerUrl;
		tokenInput.value = phoneToken;
		status.textContent = 'Phone connection saved.';
	} catch (error) {
		status.textContent = error.message;
	} finally {
		controls.disabled = false;
	}
}

/** Forget this phone connection without changing the Google credential. */
async function remove() {
	controls.disabled = true;
	try {
		await browser.storage.local.remove(['phoneServerUrl', 'phoneToken']);
		urlInput.value = '';
		tokenInput.value = '';
		status.textContent = 'Phone connection removed.';
	} catch {
		status.textContent = 'Could not remove phone settings. Please try again.';
	} finally {
		controls.disabled = false;
	}
}

form.addEventListener('submit', save);
document.querySelector('#remove-phone').addEventListener('click', remove);
load();
