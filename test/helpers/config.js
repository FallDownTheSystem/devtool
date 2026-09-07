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
assert.ok(store.configPath().startsWith(directory), 'Tests must not use the real configuration');

after(() => rmSync(directory, { recursive: true, force: true }));

export default store;
