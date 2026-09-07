import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import store from './helpers/config.js';

const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));
function run(...args) {
	const result = spawnSync(process.execPath, [cli, 'config', ...args], {
		encoding: 'utf8',
		env: { ...process.env, NO_COLOR: '1' },
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout + result.stderr;
}

test('config set accepts every schema key, including Service Desk', () => {
	for (const [section, definition] of Object.entries(store.schema)) {
		for (const name of Object.keys(definition.properties)) {
			const key = `${section}.${name}`;
			assert.match(run('set', key, 'test-value'), new RegExp(`Set ${key}`));
			assert.equal(store.get(key), 'test-value');
		}
	}
});

test('config show includes Service Desk and masks its token', () => {
	store.set('bitbucket.workspace', 'workspace');
	store.set('bitbucket.token', 'bb-token');
	store.set('jira.baseUrl', 'https://jira.example.invalid');
	store.set('jira.token', 'jira-token');
	store.set('serviceDesk.baseUrl', 'https://example.atlassian.net');
	store.set('serviceDesk.email', 'test@example.invalid');
	store.set('serviceDesk.token', 'secret-service-desk-token');
	store.set('serviceDesk.defaultProject', 'TEST');
	const output = run('show');
	assert.match(output, /Service Desk/);
	assert.match(output, /https:\/\/example.atlassian.net/);
	assert.match(output, /test@example.invalid/);
	assert.match(output, /TEST/);
	assert.match(output, /Token: secr•{16}/);
	assert.doesNotMatch(output, /secret-service-desk-token/);
});

test('config show displays partial configuration without unrelated integration credentials', () => {
	store.set('bitbucket.token', '');
	store.set('jira.token', '');
	assert.match(run('show'), /Service Desk/);
});
