const form = document.querySelector('#settings');
const controls = document.querySelector('#controls');
const input = document.querySelector('#api-key');
const removeButton = document.querySelector('#remove-key');
const status = document.querySelector('#status');

/** Load the saved key into a masked input before enabling preference changes. */
async function loadKey() {
	try {
		const { apiKey } = await browser.storage.local.get('apiKey');
		input.value = typeof apiKey === 'string' ? apiKey : '';
	} catch {
		status.textContent = 'Could not load the saved key. Try reopening Preferences.';
	} finally {
		controls.disabled = false;
	}
}

/**
 * Save locally without testing the key or making a billable translation request.
 * @param {SubmitEvent} event The preferences form submission.
 */
async function saveKey(event) {
	event.preventDefault();
	const apiKey = input.value.trim();
	if (!apiKey) {
		status.textContent = 'Enter an API key, or use Remove key to delete the saved key.';
		input.focus();
		return;
	}

	controls.disabled = true;
	try {
		await browser.storage.local.set({ apiKey });
		input.value = apiKey;
		status.textContent = 'API key saved.';
	} catch {
		status.textContent = 'Could not save the API key. Please try again.';
	} finally {
		controls.disabled = false;
	}
}

/** Remove the local credential and clear its masked display. */
async function removeKey() {
	controls.disabled = true;
	try {
		await browser.storage.local.remove('apiKey');
		input.value = '';
		status.textContent = 'API key removed.';
	} catch {
		status.textContent = 'Could not remove the API key. Please try again.';
	} finally {
		controls.disabled = false;
	}
}

form.addEventListener('submit', saveKey);
removeButton.addEventListener('click', removeKey);
loadKey();
