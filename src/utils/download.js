import { open, rm, lstat, mkdtemp, link, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Checked before any request, so a taken path or a missing folder fails without a download.
export async function assertNewPath(destination) {
	const folder = await stat(dirname(resolve(destination))).catch(() => null);
	if (!folder?.isDirectory()) throw new Error('The destination folder does not exist.');
	try {
		await lstat(destination);
	} catch (err) {
		if (err.code === 'ENOENT') return;
		throw err;
	}
	throw Object.assign(new Error('Destination already exists. Choose a new local path.'), { code: 'EEXIST' });
}

// Writes a response body to a destination that must not exist yet, and never overwrites one. A body
// that is not read to the end is cancelled, so an open download cannot keep the process alive.
export async function saveNewFile(destination, body) {
	try {
		return await writeNewFile(destination, body);
	} catch (err) {
		// A stream the pipeline already took is locked; the pipeline has destroyed it.
		await body.cancel().catch(() => {});
		throw err;
	}
}

async function writeNewFile(destination, body) {
	await assertNewPath(destination);
	const directory = await mkdtemp(join(dirname(resolve(destination)), '.devtool-download-'));
	const temporary = join(directory, 'content');
	let failure;
	try {
		const file = await open(temporary, 'wx', 0o600);
		try {
			await pipeline(Readable.fromWeb(body), file.createWriteStream());
		} finally {
			await file.close();
		}
		// Publish only a complete file. An atomic hard link refuses a concurrently created destination.
		await link(temporary, destination);
		return { path: resolve(destination), size: (await stat(destination)).size };
	} catch (err) {
		failure = err;
		throw err;
	} finally {
		try {
			await rm(directory, { recursive: true, force: true });
		} catch (err) {
			if (failure) failure.message += ' Temporary download cleanup failed.';
			else throw new Error('The download is complete, but temporary file cleanup failed.', { cause: err });
		}
	}
}

export function parseTimeout(timeout) {
	if (!/^\d+$/.test(String(timeout)) || Number(timeout) < 1 || Number(timeout) > 86400) throw new Error('Download timeout must be 1–86400 seconds.');
	return Number(timeout) * 1000;
}
