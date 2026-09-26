/** Restrict the display connection to this computer or a private IPv4 LAN. */
export function normalizeServerUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error('Enter a local server URL, such as http://192.168.1.42:8787.');
	}
	const octets = url.hostname.split('.').map(Number);
	const ipv4 = octets.length === 4 && octets.every(part => Number.isInteger(part) && part >= 0 && part <= 255);
	const local = url.hostname === 'localhost' || (ipv4 && (
		octets[0] === 127 || octets[0] === 10
		|| (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
		|| (octets[0] === 192 && octets[1] === 168)
	));
	if (!local || url.protocol !== 'http:'
		|| url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
		throw new Error('Use an HTTP server on localhost or a private IPv4 LAN, without a path.');
	}
	return url.origin;
}

/** Send only the displayed text to the local relay; the Google API key stays here. */
export async function publishTranslation(serverUrl, token, result, signal) {
	const url = `${normalizeServerUrl(serverUrl)}/api/translation`;
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
		body: JSON.stringify(result),
		credentials: 'omit',
		cache: 'no-store',
		referrerPolicy: 'no-referrer',
		signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
	});
	if (!response.ok) {
		throw new Error(response.status === 401
			? 'The phone pairing token was rejected. Check Preferences.'
			: `The phone server returned HTTP ${response.status}.`);
	}
}
