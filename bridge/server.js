import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '../src/languages.js';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BODY_LIMIT = 128 * 1024;
const CLIENT_BUFFER_LIMIT = 256 * 1024;
const STATIC_FILES = new Map([
	['/', ['index.html', 'text/html; charset=utf-8']],
	['/index.html', ['index.html', 'text/html; charset=utf-8']],
	['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
	['/app.css', ['app.css', 'text/css; charset=utf-8']],
	['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
	['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);

/**
 * Accept literal loopback or RFC 1918 IPv4 addresses, excluding wildcard binds.
 * @param {unknown} host The configured listening address.
 * @returns {boolean} Whether this address is local or private.
 */
export function isPrivateHost(host) {
	if (typeof host !== 'string' || isIP(host) !== 4) return false;
	const [first, second] = host.split('.').map(Number);
	return first === 127 || first === 10 || (first === 192 && second === 168)
		|| (first === 172 && second >= 16 && second <= 31);
}

/** Compare the pairing token without exposing matching character positions. */
function matchesToken(candidate, expected) {
	if (typeof candidate !== 'string') return false;
	const actual = Buffer.from(candidate);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Respond with a short, fixed JSON error rather than reflecting submitted data. */
function fail(response, status, message) {
	response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
	response.end(JSON.stringify({ error: message }));
}

/**
 * Read a bounded request without buffering oversized input or destroying its response.
 * @param {http.IncomingMessage} request Incoming HTTP request.
 * @returns {Promise<Buffer>} The request bytes.
 */
function readBody(request) {
	return new Promise((resolveBody, reject) => {
		const chunks = [];
		let size = 0;
		let finished = false;
		request.on('data', chunk => {
			if (finished) return;
			size += chunk.length;
			if (size > BODY_LIMIT) {
				finished = true;
				chunks.length = 0;
				reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => {
			if (!finished) resolveBody(Buffer.concat(chunks));
		});
		request.on('error', () => reject(Object.assign(new Error('Incomplete request.'), { status: 400 })));
		request.on('aborted', () => reject(Object.assign(new Error('Incomplete request.'), { status: 400 })));
	});
}

/** Validate the relay message and discard no fields silently. */
function translationState(payload) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)
		|| Object.keys(payload).some(key => !['source', 'translation', 'error', 'targetLanguage'].includes(key))) {
		return null;
	}
	const { source, translation, error = '' } = payload;
	if (typeof source !== 'string' || typeof translation !== 'string' || typeof error !== 'string'
		|| [...source].length > 5000 || [...translation].length > 20000 || [...error].length > 1000) {
		return null;
	}
	const language = {};
	if (Object.hasOwn(payload, 'targetLanguage')) {
		if (!LANGUAGES.has(payload.targetLanguage)) return null;
		language.targetLanguage = payload.targetLanguage;
	}
	return { source, translation, error, ...language, updatedAt: new Date().toISOString() };
}

/** Allow authenticated extension requests and the relay's own origin only. */
function allowedOrigin(origin, ownOrigin) {
	return origin === undefined || origin === ownOrigin
		|| /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(origin);
}

/** Write an event or heartbeat, disconnecting clients that cannot keep up. */
function writeEvent(response, event) {
	if (response.destroyed || response.writableLength > CLIENT_BUFFER_LIMIT) {
		response.destroy();
		return;
	}
	response.write(event);
	if (response.writableLength > CLIENT_BUFFER_LIMIT) response.destroy();
}

/**
 * Start an authenticated LAN relay with latest-state SSE and fixed phone assets.
 * Translation state remains in memory and is lost when the server stops.
 * @param {object} config Relay configuration.
 * @param {string} config.token A random 64-character hexadecimal pairing token.
 * @param {string} [config.host='127.0.0.1'] Private IPv4 listening address.
 * @param {number} [config.port=8787] Listening port; zero chooses a free test port.
 * @param {string} [config.publicDir] Directory containing the fixed phone files.
 * @returns {Promise<http.Server>} The listening server.
 */
export async function startBridge(config) {
	const { host = '127.0.0.1', port = 8787, token } = config;
	if (!isPrivateHost(host)) throw new Error('Bind to a private or loopback IPv4 address, not a public or wildcard address.');
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
	if (typeof token !== 'string' || !/^[0-9a-f]{64}$/iu.test(token)) throw new Error('Pairing token must be 64 hexadecimal characters.');
	const publicDir = resolve(config.publicDir ?? resolve(PROJECT_DIR, 'phone'));
	const expectedToken = Buffer.from(token);
	const clients = new Set();
	let state = { source: '', translation: '', error: '', updatedAt: null };
	let ownOrigin;

	/** Route one request without allowing arbitrary filesystem paths or CORS access. */
	async function handle(request, response) {
		response.setHeader('Cache-Control', 'no-store');
		response.setHeader('X-Content-Type-Options', 'nosniff');
		response.setHeader('Referrer-Policy', 'no-referrer');
		response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
		response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
		const pathname = request.url.split('?')[0];
		if (pathname === '/api/translation') {
			if (request.method !== 'POST') {
				response.setHeader('Allow', 'POST');
				fail(response, 405, 'Use POST.');
				return;
			}
			if (!matchesToken(request.headers.authorization?.replace(/^Bearer /u, ''), expectedToken)
				|| !request.headers.authorization?.startsWith('Bearer ')) {
				request.resume();
				fail(response, 401, 'Pairing token required.');
				return;
			}
			if (!allowedOrigin(request.headers.origin, ownOrigin)) {
				request.resume();
				fail(response, 403, 'Origin is not allowed.');
				return;
			}
			if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
				request.resume();
				fail(response, 415, 'Use application/json.');
				return;
			}
			let payload;
			try {
				payload = JSON.parse((await readBody(request)).toString('utf8'));
			} catch (error) {
				fail(response, error.status ?? 400, error.status === 413 ? 'Request body is too large.' : 'Invalid JSON request.');
				return;
			}
			const nextState = translationState(payload);
			if (!nextState) {
				fail(response, 400, 'Use source and translation strings, with an optional error string, within the length limits.');
				return;
			}
			state = nextState;
			for (const client of clients) writeEvent(client, `data: ${JSON.stringify(state)}\n\n`);
			response.writeHead(204);
			response.end();
			return;
		}
		if (pathname === '/events') {
			if (request.method !== 'GET') {
				response.setHeader('Allow', 'GET');
				fail(response, 405, 'Use GET.');
				return;
			}
			const query = new URL(request.url, ownOrigin).searchParams;
			if (!matchesToken(query.get('token'), expectedToken)) {
				fail(response, 401, 'Pairing token required.');
				return;
			}
			if (!allowedOrigin(request.headers.origin, ownOrigin)) {
				fail(response, 403, 'Origin is not allowed.');
				return;
			}
			response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
			response.flushHeaders();
			clients.add(response);
			writeEvent(response, `data: ${JSON.stringify(state)}\n\n`);
			const heartbeat = setInterval(() => writeEvent(response, ': heartbeat\n\n'), 20_000);
			heartbeat.unref();
			response.on('close', () => {
				clearInterval(heartbeat);
				clients.delete(response);
			});
			return;
		}
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			response.setHeader('Allow', 'GET, HEAD');
			fail(response, 405, 'Use GET or HEAD.');
			return;
		}
		const file = STATIC_FILES.get(pathname);
		if (!file) {
			fail(response, 404, 'Not found.');
			return;
		}
		try {
			const content = await readFile(resolve(publicDir, file[0]));
			response.writeHead(200, { 'Content-Type': file[1], 'Content-Length': content.length });
			response.end(request.method === 'HEAD' ? undefined : content);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
			fail(response, 404, 'Not found.');
		}
	}

	/** Prevent asynchronous routing errors from exposing request or token contents. */
	function listener(request, response) {
		handle(request, response).catch(() => {
			if (response.headersSent) response.destroy();
			else fail(response, 500, 'Relay request failed.');
		});
	}
	const server = http.createServer(listener);
	server.requestTimeout = 15_000;
	server.headersTimeout = 10_000;
	server.keepAliveTimeout = 5000;
	await new Promise((resolveListen, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => {
			server.off('error', reject);
			ownOrigin = `http://${host}:${server.address().port}`;
			resolveListen();
		});
	});
	return server;
}

/** Load a local configuration and print the pairing details once on startup. */
async function main() {
	const configPath = resolve(process.argv[2] ?? resolve(PROJECT_DIR, '.local/phone/config.json'));
	const config = JSON.parse(await readFile(configPath, 'utf8'));
	const server = await startBridge(config);
	const baseUrl = `http://${config.host ?? '127.0.0.1'}:${server.address().port}`;
	console.log(`Phone pairing URL: ${baseUrl}/#token=${config.token}`);
	console.log(`Extension relay URL: ${baseUrl}`);
	console.log(`Extension pairing token: ${config.token}`);
	for (const signal of ['SIGINT', 'SIGTERM']) {
		process.once(signal, () => {
			server.closeAllConnections();
			server.close();
		});
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(error => {
		console.error(`Could not start the phone relay: ${error.message}`);
		process.exitCode = 1;
	});
}
