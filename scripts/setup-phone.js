import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

/** A physical LAN address keeps the display off public and wildcard interfaces. */
function isPrivateAddress(address) {
	const parts = address.split('.').map(Number);
	return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part < 256)
		&& (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
			|| (parts[0] === 192 && parts[1] === 168));
}

/** Create local settings once, preserving the pairing token on later setup runs. */
async function main() {
	const directory = resolve(import.meta.dirname, '../.local/phone');
	let host = process.argv[2];
	if (!host) {
		const addresses = Object.entries(networkInterfaces())
			.filter(([name]) => !/^(docker|br-|veth|virbr|podman)/u.test(name))
			.flatMap(([, entries]) => entries)
			.filter(entry => !entry.internal && entry.family === 'IPv4' && isPrivateAddress(entry.address))
			.map(entry => entry.address);
		if (addresses.length !== 1) {
			throw new Error(`Choose the computer’s LAN IPv4 address: npm run phone:setup -- 192.168.1.42. Found: ${addresses.join(', ') || 'none'}`);
		}
		[host] = addresses;
	}
	if (!isPrivateAddress(host)) throw new Error('Use this computer’s private LAN IPv4 address.');
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = resolve(directory, 'config.json');
	let previous;
	try {
		previous = JSON.parse(await readFile(path, 'utf8'));
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	const token = previous?.token ?? randomBytes(32).toString('hex');
	const config = { host, port: 8787, token };
	await writeFile(path, `${JSON.stringify(config, null, '\t')}\n`, { mode: 0o600 });
	console.log(`Saved ${path}\nStart the display server with: npm run phone`);
}

await main().catch(error => {
	console.error(error.message);
	process.exitCode = 1;
});
