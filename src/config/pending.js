import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDirectory } from './store.js';

// A pending write waits this long for approval; after that it must be requested again against fresh data.
const PENDING_TTL_MS =24 * 60 * 60 * 1000;

const ID_PATTERN = /^[0-9a-f]{8}$/;

function directory() {
	return join(configDirectory(), 'pending');
}

function entryPath(id) {
	return join(directory(), `${id}.json`);
}

function checkId(id) {
	if (!ID_PATTERN.test(id)) throw new Error(`Invalid pending action ID "${id}". Run \`dev pending list\` to see pending actions.`);
}

function expired(entry, now = Date.now()) {
	return !(Date.parse(entry.expiresAt) > now);
}

function read(id) {
	try {
		return JSON.parse(readFileSync(entryPath(id), 'utf8'));
	} catch (err) {
		if (err.code === 'ENOENT') return null;
		throw err;
	}
}

function remove(id) {
	try {
		unlinkSync(entryPath(id));
		return true;
	} catch (err) {
		if (err.code === 'ENOENT') return false;
		throw err;
	}
}

// Written to a temporary name first so a reader never sees a partial entry.
function write(entry) {
	mkdirSync(directory(), { recursive: true });
	const temp = join(directory(), `.${entry.id}.${process.pid}.tmp`);
	writeFileSync(temp, JSON.stringify(entry, null, 2), { mode: 0o600 });
	renameSync(temp, entryPath(entry.id));
}

export function addPending({ action, connection, target, params }) {
	const now = Date.now();
	const entry = {
		id: randomBytes(4).toString('hex'),
		action,
		connection,
		target,
		params,
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + PENDING_TTL_MS).toISOString(),
	};
	write(entry);
	return entry;
}

// Expired entries are deleted as they are found.
export function listPending() {
	let names;
	try {
		names = readdirSync(directory());
	} catch (err) {
		if (err.code === 'ENOENT') return [];
		throw err;
	}
	const now = Date.now();
	const entries = [];
	for (const name of names) {
		const id = name.replace(/\.json$/, '');
		if (!ID_PATTERN.test(id) || name !== `${id}.json`) continue;
		const entry = read(id);
		if (!entry) continue;
		if (expired(entry, now)) remove(id);
		else entries.push(entry);
	}
	return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getPending(id) {
	checkId(id);
	const entry = read(id);
	if (!entry) throw new Error(`No pending action "${id}". It was approved, rejected, or never created. Run \`dev pending list\`.`);
	if (expired(entry)) {
		remove(id);
		throw new Error(`Pending action "${id}" expired. Run the original command again to request a new approval.`);
	}
	return entry;
}

// Deleting the file is the claim: when two approvals race, only one deletion succeeds.
export function claimPending(id) {
	const entry = getPending(id);
	if (!remove(id)) throw new Error(`Pending action "${id}" was already approved or rejected.`);
	return entry;
}

export function restorePending(entry) {
	write(entry);
}
