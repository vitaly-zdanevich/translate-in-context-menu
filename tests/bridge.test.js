import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isPrivateHost, startBridge } from '../bridge/server.js';

const TOKEN = 'a'.repeat(64);

/** Start an isolated relay with known phone assets and close sockets after the test. */
async function setup(context) {
	const publicDir = await mkdtemp(join(tmpdir(), 'translation-bridge-test-'));
	await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Phone</title>');
	await writeFile(join(publicDir, 'app.js'), 'document.title = \'Translation\';');
	await writeFile(join(publicDir, 'app.css'), 'body { color: black; }');
	await writeFile(join(publicDir, 'manifest.webmanifest'), '{}');
	await writeFile(join(publicDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
	await writeFile(join(publicDir, 'private.key'), 'must never be served');
	const server = await startBridge({ host: '127.0.0.1', port: 0, token: TOKEN, publicDir });
	const base = `http://127.0.0.1:${server.address().port}`;
	const controllers = [];
	context.after(async () => {
		for (const controller of controllers) controller.abort();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
		await rm(publicDir, { recursive: true });
	});
	return {
		base, server,
		post: (payload, headers = {}) => fetch(`${base}/api/translation`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(payload),
		}),
		stream: async () => {
			const controller = new AbortController();
			controllers.push(controller);
			const response = await fetch(`${base}/events?token=${TOKEN}`, { signal: controller.signal });
			assert.equal(response.status, 200);
			assert.match(response.headers.get('content-type'), /^text\/event-stream/u);
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let pending = '';
			return {
				close: () => controller.abort(),
				/** Read a default SSE message, ignoring comments and preserving chunk boundaries. */
				next: async () => {
					for (;;) {
						const boundary = pending.indexOf('\n\n');
						if (boundary !== -1) {
							const event = pending.slice(0, boundary);
							pending = pending.slice(boundary + 2);
							if (event.startsWith('data: ')) return JSON.parse(event.slice(6));
							continue;
						}
						const { value, done } = await reader.read();
						assert.equal(done, false, 'SSE stream closed before the next translation');
						pending += decoder.decode(value, { stream: true });
					}
				},
			};
		},
	};
}

/** Send a literal path without fetch normalizing traversal components. */
function rawRequest(base, path, { method = 'GET', headers = {}, chunks = [] } = {}) {
	return new Promise((resolve, reject) => {
		const request = http.request(base, { path, method, headers }, response => {
			const body = [];
			response.on('data', chunk => body.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(body).toString() }));
		});
		request.on('error', reject);
		for (const chunk of chunks) request.write(chunk);
		request.end();
	});
}

test('relay configuration accepts only literal private or loopback IPv4 addresses', async () => {
	for (const host of ['127.0.0.1', '127.1.2.3', '10.2.3.4', '172.16.0.1', '172.31.255.254', '192.168.1.4']) {
		assert.equal(isPrivateHost(host), true, host);
	}
	for (const host of ['0.0.0.0', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.1.1', 'localhost', '::', 'example.com', null]) {
		assert.equal(isPrivateHost(host), false, String(host));
		await assert.rejects(startBridge({ host, token: TOKEN }), /private or loopback/u);
	}
	for (const token of ['', 'a'.repeat(63), 'z'.repeat(64), undefined]) {
		await assert.rejects(startBridge({ token }), /64 hexadecimal/u);
	}
	for (const port of [-1, 65536, '8787', 0.5]) {
		await assert.rejects(startBridge({ token: TOKEN, port }), /Port must/u);
	}
});

test('posting and reading events both require the current pairing token', async context => {
	const app = await setup(context);
	for (const candidate of ['', 'b'.repeat(64), 'outdated-pairing-token']) {
		const post = await app.post({ source: 'Hello', translation: 'Привет' }, { Authorization: `Bearer ${candidate}` });
		assert.equal(post.status, 401);
		const events = await fetch(`${app.base}/events?token=${candidate}`);
		assert.equal(events.status, 401);
		assert.equal(events.headers.get('cache-control'), 'no-store');
	}
	assert.equal((await fetch(`${app.base}/events`)).status, 401);
	assert.equal((await fetch(`${app.base}/api/translation`, { method: 'POST' })).status, 401);
	assert.equal((await app.post({ source: '', translation: '' }, { Authorization: TOKEN })).status, 401);
	const stream = await app.stream();
	assert.deepEqual(await stream.next(), { source: '', translation: '', error: '', updatedAt: null });
});

test('an authenticated translation reaches connected phones and reconnecting phones', async context => {
	const app = await setup(context);
	const first = await app.stream();
	await first.next();
	const second = await app.stream();
	await second.next();
	const response = await app.post({ source: 'Hello\nworld', translation: 'Привет\nмир' });
	assert.equal(response.status, 204);
	assert.equal(await response.text(), '');
	const state = await first.next();
	assert.equal(state.source, 'Hello\nworld');
	assert.equal(state.translation, 'Привет\nмир');
	assert.equal(state.error, '');
	assert.equal(new Date(state.updatedAt).toISOString(), state.updatedAt);
	assert.deepEqual(await second.next(), state);
	first.close();
	const reconnected = await app.stream();
	assert.deepEqual(await reconnected.next(), state);
	assert.equal((await app.post({ source: 'Again', translation: '', error: 'Translation unavailable.' })).status, 204);
	assert.equal((await second.next()).error, 'Translation unavailable.');
});

test('slow phones are disconnected without blocking another phone or the publisher', async context => {
	const app = await setup(context);
	let slowResponse;
	app.server.once('request', (_request, response) => { slowResponse = response; });
	const slow = await app.stream();
	await slow.next();
	const healthy = await app.stream();
	await healthy.next();
	// Model a backed-up socket deterministically without sending megabytes over the network.
	Object.defineProperty(slowResponse, 'writableLength', { get: () => 300 * 1024 });
	const closed = once(slowResponse, 'close');
	assert.equal((await app.post({ source: 'Hello', translation: 'Привет' })).status, 204);
	await closed;
	assert.equal(slowResponse.destroyed, true);
	assert.equal((await healthy.next()).translation, 'Привет');
	assert.equal((await app.post({ source: 'Again', translation: 'Снова' })).status, 204);
	assert.equal((await healthy.next()).translation, 'Снова');
});

test('a fresh server starts empty even when the pairing token is reused', async context => {
	const original = await setup(context);
	await original.post({ source: 'Private text', translation: 'Личный текст' });
	const fresh = await setup(context);
	const stream = await fresh.stream();
	assert.deepEqual(await stream.next(), { source: '', translation: '', error: '', updatedAt: null });
});

test('untrusted origins cannot read or overwrite the current translation', async context => {
	const app = await setup(context);
	const message = { source: 'Hello', translation: 'Привет' };
	for (const origin of ['https://attacker.example', 'null', `${app.base}.attacker.example`, 'moz-extension://fake/path']) {
		assert.equal((await app.post(message, { Origin: origin })).status, 403);
		const response = await fetch(`${app.base}/events?token=${TOKEN}`, { headers: { Origin: origin } });
		assert.equal(response.status, 403);
		assert.equal(response.headers.get('access-control-allow-origin'), null);
	}
	assert.equal((await app.post(message, { Origin: app.base })).status, 204);
	assert.equal((await app.post(message, { Origin: 'moz-extension://12345678-1234-1234-1234-123456789abc' })).status, 204);
});

test('invalid messages and oversized bodies do not replace accepted state', async context => {
	const app = await setup(context);
	await app.post({ source: 'Keep', translation: 'Сохранить' });
	for (const invalid of [null, [], {}, { source: 3, translation: '' }, { source: '', translation: null },
		{ source: '', translation: '', apiKey: 'never-forward-this' }, { source: '', translation: '', error: 7 },
		{ source: 'x'.repeat(5001), translation: '' }, { source: '', translation: 'x'.repeat(20001) },
		{ source: '', translation: '', error: 'x'.repeat(1001) }]) {
		assert.equal((await app.post(invalid)).status, 400);
	}
	const malformed = await fetch(`${app.base}/api/translation`, {
		method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{',
	});
	assert.equal(malformed.status, 400);
	assert.equal((await app.post({ source: '', translation: '' }, { 'Content-Type': 'text/plain' })).status, 415);
	assert.equal((await app.post({ source: 'x'.repeat(128 * 1024), translation: '' })).status, 413);
	const chunked = await rawRequest(app.base, '/api/translation', {
		method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
		chunks: ['x'.repeat(70 * 1024), 'x'.repeat(70 * 1024)],
	});
	assert.equal(chunked.status, 413);
	const stream = await app.stream();
	assert.equal((await stream.next()).source, 'Keep');
	assert.equal((await app.post({ source: '😀'.repeat(5000), translation: 'я'.repeat(20000), error: 'x'.repeat(1000) })).status, 204);
});

test('only fixed phone assets are served with correct types and protective headers', async context => {
	const app = await setup(context);
	for (const [path, type] of [['/', 'text/html'], ['/index.html', 'text/html'], ['/app.js', 'text/javascript'],
		['/app.css', 'text/css'], ['/manifest.webmanifest', 'application/manifest+json'], ['/icon.svg', 'image/svg+xml']]) {
		const response = await fetch(`${app.base}${path}`);
		assert.equal(response.status, 200);
		assert.ok(response.headers.get('content-type').startsWith(type));
		assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
		assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
		assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/u);
		assert.equal(response.headers.get('access-control-allow-origin'), null);
	}
	const head = await fetch(`${app.base}/`, { method: 'HEAD' });
	assert.equal(head.status, 200);
	assert.equal(await head.text(), '');
	for (const path of ['/private.key', '/../server.js', '/%2e%2e/server.js', '/app.js/../../private.key', '/ca.crt', '/sw.js']) {
		assert.equal((await rawRequest(app.base, path)).status, 404, path);
	}
	assert.equal((await fetch(`${app.base}/api/translation`)).status, 405);
	assert.equal((await fetch(`${app.base}/events`, { method: 'POST' })).status, 405);
	assert.equal((await fetch(`${app.base}/`, { method: 'POST' })).status, 405);
	assert.equal((await fetch(`${app.base}/api/translation`, { method: 'OPTIONS' })).status, 405);
});
