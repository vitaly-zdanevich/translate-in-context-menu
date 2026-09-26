const pairing = document.getElementById('pairing');
const pairingForm = document.getElementById('pairing-form');
const pairingInput = document.getElementById('pairing-token');
const pairingError = document.getElementById('pairing-error');
const status = document.getElementById('connection-status');
const forgetButton = document.getElementById('forget-button');
const viewer = document.getElementById('viewer');
const original = document.getElementById('original');
const translation = document.getElementById('translation');
const translationError = document.getElementById('translation-error');
const messageTime = document.getElementById('message-time');
const tokenPattern = /^[a-f\d]{64}$/iu;
let eventSource;

/**
 * Display a server update as literal text; translated content never becomes HTML.
 * @param {MessageEvent} event An SSE message containing the latest translation.
 */
function showTranslation(event) {
	try {
		const message = JSON.parse(event.data);
		if (!message || typeof message !== 'object' || Array.isArray(message)
			|| ['source', 'translation', 'error'].some(key => message[key] != null && typeof message[key] !== 'string')) {
			throw new Error('Invalid translation update');
		}
		original.textContent = message.source ?? '';
		translation.textContent = message.translation
			|| (message.error ? '' : message.source ? 'Переводим…' : 'Select text on your computer and use the shortcut.');
		translationError.textContent = message.error ?? '';
		const date = new Date(message.updatedAt ?? NaN);
		messageTime.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
		messageTime.dateTime = Number.isNaN(date.getTime()) ? '' : date.toISOString();
	} catch {
		translationError.textContent = 'Could not read a translation update.';
	}
}

/**
 * Save only the pairing credential, then subscribe to the local desktop server.
 * @param {string} token A validated 64-character hexadecimal pairing token.
 */
function connect(token) {
	eventSource?.close();
	pairingError.textContent = '';
	try {
		localStorage.setItem('pairingToken', token);
	} catch {
		// Pairing still works for this page when persistent storage is unavailable.
	}
	pairingInput.value = '';
	pairing.hidden = true;
	viewer.hidden = false;
	forgetButton.hidden = false;
	status.textContent = 'Connecting…';
	const connection = new EventSource(`/events?${new URLSearchParams({ token })}`);
	eventSource = connection;
	connection.onopen = () => {
		if (eventSource === connection) status.textContent = 'Connected';
	};
	connection.onerror = () => {
		if (eventSource !== connection) return;
		status.textContent = connection.readyState === EventSource.CLOSED
			? 'Disconnected. Pair again to reconnect.'
			: 'Reconnecting…';
	};
	connection.onmessage = event => {
		if (eventSource === connection) showTranslation(event);
	};
}

/** Validate a manually entered pairing token before opening a connection. */
pairingForm.addEventListener('submit', event => {
	event.preventDefault();
	const token = pairingInput.value.trim();
	if (!tokenPattern.test(token)) {
		pairingError.textContent = 'Enter the 64-character pairing token from your computer.';
		pairingInput.focus();
		return;
	}
	connect(token);
});

/** Forget the credential and clear displayed text without saving translation history. */
forgetButton.addEventListener('click', () => {
	eventSource?.close();
	eventSource = undefined;
	try {
		localStorage.removeItem('pairingToken');
	} catch {
		// The connection and displayed text are still cleared if storage is blocked.
	}
	original.textContent = '';
	translation.textContent = '';
	translationError.textContent = '';
	messageTime.textContent = '';
	messageTime.dateTime = '';
	pairingInput.value = '';
	pairingError.textContent = '';
	pairing.hidden = false;
	viewer.hidden = true;
	forgetButton.hidden = true;
	status.textContent = 'Pair your phone';
	pairingInput.focus();
});

/** Consume fragment credentials before connecting so bookmarks do not retain them. */
function restorePairing() {
	const fragment = new URLSearchParams(location.hash.slice(1));
	const suppliedToken = fragment.get('token');
	if (location.hash) history.replaceState(null, '', location.pathname + location.search);
	let token = suppliedToken;
	if (token === null) {
		try {
			token = localStorage.getItem('pairingToken');
		} catch {
			// Manual pairing remains available when storage cannot be read.
		}
	}
	if (typeof token === 'string' && tokenPattern.test(token)) {
		connect(token);
	} else if (suppliedToken !== null) {
		pairingError.textContent = 'This pairing link is invalid. Copy a new link from your computer.';
	}
}

restorePairing();
