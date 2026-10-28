import assert from 'node:assert/strict';
import { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'devtool-test-'));
process.env.APPDATA = directory;
process.env.XDG_CONFIG_HOME = directory;
process.env.HOME = directory;
process.env.USERPROFILE = directory;
const store = await import('../../src/config/store.js');
const { credentialStore } = await import('../../src/config/secrets.js');

// Tests never touch the real OS credential store; this in-memory one replaces it in the test process.
export const storedSecrets = new Map();
credentialStore.get = (name) => storedSecrets.get(name) ?? null;
credentialStore.set = (name, value) => { storedSecrets.set(name, value); };
credentialStore.delete = (name) => storedSecrets.delete(name);
assert.ok(store.configPath().startsWith(directory), 'Tests must not use the real configuration');

after(() => rmSync(directory, { recursive: true, force: true }));

export default store;
