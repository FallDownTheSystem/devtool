import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';

const FORMAT = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

function storeError(err) {
	return new Error('Cannot open the OS credential store for the Graph token cache. Check your Windows account, macOS Keychain, or Linux Secret Service. Plaintext storage is disabled.', { cause: err });
}

// The OS store holds only the key: Windows Credential Manager limits a secret to about 2.5 KB, less than an MSAL cache.
export async function keyringKeyStore(identity) {
	const { AsyncEntry } = await import('@napi-rs/keyring');
	// Linux would otherwise fall back to the kernel keyring, which loses the key at logout or reboot.
	const entry = new AsyncEntry('devtool-graph-key', identity, { linux: { store: 'secret-service' } });
	return {
		async get() {
			try {
				const secret = await entry.getSecret();
				return secret ? Buffer.from(secret) : null;
			} catch (err) {
				throw storeError(err);
			}
		},
		async set(key) {
			try {
				await entry.setSecret(key);
			} catch (err) {
				throw storeError(err);
			}
		},
	};
}

function fileLock(path, { timeout = 10000, stale = 30000, retry = 50 } = {}) {
	let held = false;
	return {
		async acquire() {
			const deadline = Date.now() + timeout;
			for (;;) {
				try {
					await (await open(path, 'wx')).close();
					held = true;
					return;
				} catch (err) {
					if (err.code !== 'EEXIST') throw err;
				}
				// A process killed while holding the lock leaves the file behind.
				const age = await stat(path).then((s) => Date.now() - s.mtimeMs, () => 0);
				if (age > stale) await rm(path, { force: true });
				else if (Date.now() > deadline) throw new Error('Timed out waiting for another devtool process to release the Graph token cache.');
				else await new Promise((resolve) => setTimeout(resolve, retry));
			}
		},
		async release() {
			if (!held) return;
			held = false;
			await rm(path, { force: true });
		},
	};
}

/**
 * MSAL cache plugin that stores the token cache AES-256-GCM encrypted in a file, keyed by a random
 * key in the OS credential store. The identity is bound as associated data so files cannot be swapped.
 */
export function createProtectedCache({ path, identity, keyStore = () => keyringKeyStore(identity), lockOptions }) {
	const lock = fileLock(`${path}.lock`, lockOptions);
	const aad = Buffer.from(identity);
	let store;
	const keys = async () => (store ||= await keyStore());

	async function readKey() {
		const key = await (await keys()).get();
		return key?.length === KEY_BYTES ? key : null;
	}

	// A missing key or a file that fails authentication is an empty cache: the user signs in again.
	async function load() {
		let file;
		try {
			file = await readFile(path);
		} catch (err) {
			if (err.code === 'ENOENT') return null;
			throw err;
		}
		const key = await readKey();
		if (!key || file.length < HEADER_BYTES || file[0] !== FORMAT) return null;
		try {
			const decipher = createDecipheriv('aes-256-gcm', key, file.subarray(1, 1 + IV_BYTES));
			decipher.setAAD(aad);
			decipher.setAuthTag(file.subarray(1 + IV_BYTES, HEADER_BYTES));
			return Buffer.concat([decipher.update(file.subarray(HEADER_BYTES)), decipher.final()]).toString('utf8');
		} catch {
			return null;
		}
	}

	async function save(data) {
		let key = await readKey();
		if (!key) {
			key = randomBytes(KEY_BYTES);
			await (await keys()).set(key);
		}
		const iv = randomBytes(IV_BYTES);
		const cipher = createCipheriv('aes-256-gcm', key, iv);
		cipher.setAAD(aad);
		const body = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
		const temporary = `${path}.${process.pid}.tmp`;
		try {
			const file = await open(temporary, 'w', 0o600);
			try {
				await file.writeFile(Buffer.concat([Buffer.from([FORMAT]), iv, cipher.getAuthTag(), body]));
			} finally {
				await file.close();
			}
			await rename(temporary, path);
		} catch (err) {
			await rm(temporary, { force: true });
			throw err;
		}
	}

	return {
		// MSAL pairs every beforeCacheAccess with afterCacheAccess; the lock spans both when the cache will change.
		async beforeCacheAccess(context) {
			await lock.acquire();
			try {
				const data = await load();
				if (data) context.tokenCache.deserialize(data);
			} catch (err) {
				await lock.release();
				throw err;
			}
			if (!context.cacheHasChanged) await lock.release();
		},
		async afterCacheAccess(context) {
			try {
				if (context.cacheHasChanged) await save(context.tokenCache.serialize());
			} finally {
				await lock.release();
			}
		},
	};
}
