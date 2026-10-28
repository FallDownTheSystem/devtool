import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import store from './helpers/config.js';

const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));
function dev(...args) {
	const result = spawnSync(process.execPath, [cli, ...args], {
		encoding: 'utf8',
		env: { ...process.env, NO_COLOR: '1' },
		timeout: 10000,
	});
	return { status: result.status, output: result.stdout + result.stderr };
}

function run(...args) {
	const { status, output } = dev('config', ...args);
	assert.equal(status, 0, output);
	return output;
}

beforeEach(() => store.default.set('connections', []));

test('legacy single-connection sections migrate to unnamed connections', () => {
	writeFileSync(store.configPath(), JSON.stringify({
		bitbucket: { workspace: 'ws', defaultRepo: 'repo', email: 'me@example.invalid', token: 'bb-token' },
		jira: { baseUrl: 'https://jira.example.invalid', token: 'jira-token', defaultProject: '' },
		confluence: { baseUrl: '', email: '', token: '', defaultSpace: '' },
		serviceDesk: { baseUrl: '', email: '', token: '', defaultProject: '' },
	}));
	run('show');
	assert.deepEqual(JSON.parse(readFileSync(store.configPath(), 'utf8')), {
		connections: [
			{ type: 'bitbucket', workspace: 'ws', defaultRepo: 'repo', email: 'me@example.invalid', token: 'bb-token' },
			{ type: 'jira', baseUrl: 'https://jira.example.invalid', token: 'jira-token' },
		],
	});
});

// Fields with a validator need a value of the right shape.
const samples = {
	tenantId: '11111111-1111-1111-1111-111111111111',
	clientId: '22222222-2222-2222-2222-222222222222',
	defaultSite: 'https://example.sharepoint.com/sites/Test',
	projects: 'PROJ,OPS',
	deployment: 'cloud',
};

test('legacy config set keys create and update the unnamed connection of each type', () => {
	for (const [type, definition] of Object.entries(store.types)) {
		for (const name of Object.keys(definition.fields)) {
			const value = samples[name] ?? 'test-value';
			run('set', `${type}.${name}`, value);
			assert.equal(store.getConnection(type)[name], value);
		}
	}
	assert.deepEqual(store.listConnections().map((c) => c.type), Object.keys(store.types));
});

test('config set rejects unknown fields and connections', () => {
	assert.match(dev('config', 'set', 'jira.nope', 'x').output, /Invalid field "nope"/);
	assert.match(dev('config', 'set', 'missing.baseUrl', 'x').output, /No connection named "missing"/);
	assert.deepEqual(store.listConnections(), []);
});

test('connections of the same type are selected by name, with a default', () => {
	store.saveConnection({ type: 'jira', baseUrl: 'https://one.example.invalid', token: 'one' });
	store.saveConnection({ type: 'jira', name: 'work', baseUrl: 'https://two.example.invalid', token: 'two' });
	store.saveConnection({ type: 'confluence', name: 'wiki', baseUrl: 'https://wiki.example.invalid', token: 'w' });
	assert.equal(store.getConnection('jira').token, 'one');
	assert.equal(store.getConnection('jira', 'work').token, 'two');
	assert.equal(store.getConnection('jira', 'jira').token, 'one');
	assert.throws(() => store.getConnection('jira', 'wiki'), /"wiki" is a Confluence connection, not Jira/);
	assert.throws(() => store.getConnection('jira', 'nope'), /No connection named "nope"/);

	run('default', 'work');
	assert.equal(store.getConnection('jira').token, 'two');
	assert.equal(store.getConnection('jira', 'jira').token, 'one');
	run('set', 'jira.defaultProject', 'X');
	assert.equal(store.getConnection('jira', 'jira').defaultProject, 'X');

	run('remove', 'work');
	assert.equal(store.getConnection('jira').token, 'one');
});

test('connection names must be unique and distinct from type names', () => {
	store.saveConnection({ type: 'jira', name: 'work', baseUrl: 'https://a.example.invalid', token: 'a' });
	assert.throws(() => store.saveConnection({ type: 'confluence', name: 'work' }), /already exists/);
	assert.throws(() => store.saveConnection({ type: 'confluence', name: 'Jira' }), /connection type/);
	assert.throws(() => store.saveConnection({ type: 'confluence', name: 'has space' }), /letters, digits/);
	store.saveConnection({ type: 'jira' });
	assert.throws(() => store.saveConnection({ type: 'jira' }), /without a name already exists/);
	assert.match(dev('config', 'set', 'work.name', 'jira').output, /connection type/);
});

test('config show lists every connection and masks tokens', () => {
	store.saveConnection({ type: 'serviceDesk', baseUrl: 'https://example.atlassian.net', email: 'test@example.invalid', token: 'secret-service-desk-token', defaultProject: 'TEST' });
	store.saveConnection({ type: 'serviceDesk', name: 'other', baseUrl: 'https://other.atlassian.net' });
	const output = run('show');
	assert.match(output, /serviceDesk \(Service Desk, default\)/);
	assert.match(output, /other \(Service Desk\)/);
	assert.match(output, /https:\/\/example.atlassian.net/);
	assert.match(output, /test@example.invalid/);
	assert.match(output, /Token: secr•{16}/);
	assert.doesNotMatch(output, /secret-service-desk-token/);
});

test('commands run without any configuration and report only the missing connection', () => {
	assert.match(run('show'), /No connections configured/);
	const { status, output } = dev('jira', 'view', 'PROJ-1');
	assert.equal(status, 1);
	assert.match(output, /No Jira or Service Desk connection configured\. Run `dev config add jira`/);
	assert.doesNotMatch(output, /setup|Bitbucket/i);
});

test('--connection selects a connection for a command', () => {
	store.saveConnection({ type: 'bitbucket', workspace: 'ws', email: 'e', token: 't' });
	const { status, output } = dev('pr', 'list', '--connection', 'nope');
	assert.equal(status, 1);
	assert.match(output, /No connection named "nope"/);
	assert.match(dev('pr', 'list', '-c', 'bitbucket').output, /No repository specified/);
});
