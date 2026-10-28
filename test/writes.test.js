import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import store from './helpers/config.js';
import { listPending } from '../src/config/pending.js';
import { textToAdf, textToStorage } from '../src/utils/markup.js';
import { updatePage, createPage } from '../src/clients/confluence.js';
import { addComment, editIssue } from '../src/clients/serviceDesk.js';
import { addPullRequestComment, updatePullRequest } from '../src/clients/bitbucket.js';
import { merge as mergeAction } from '../src/actions/bitbucket.js';

const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));

// The CLI runs as a child process while this process serves the fake Jira, so it cannot block.
function dev(...args) {
	return devWith({}, ...args);
}

function devWith(env, ...args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, NO_COLOR: '1', ...env } });
		let output = '';
		child.stdout.on('data', (chunk) => { output += chunk; });
		child.stderr.on('data', (chunk) => { output += chunk; });
		child.on('close', (status) => resolve({ status, output }));
	});
}

let server;
let baseUrl;
let requests;
let respond;

before(async () => {
	server = createServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => { body += chunk; });
		req.on('end', () => {
			const entry = { method: req.method, path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined };
			requests.push(entry);
			const answer = respond(entry);
			if (answer === 'hang') return;
			const [status, data] = answer;
			res.writeHead(status, { 'content-type': 'application/json', ...answer[2] });
			res.end(data === undefined ? '' : JSON.stringify(data));
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
	requests = [];
	respond = () => [201, { id: '100' }];
	store.default.set('connections', []);
	rmSync(join(store.configDirectory(), 'pending'), { recursive: true, force: true });
});

function jira(settings = {}) {
	store.saveConnection({ type: 'jira', baseUrl, token: 'jira-token', ...settings });
}

const writes = () => requests.filter((r) => r.method !== 'GET');

test('writable connections default to no writes, with approval once enabled', async () => {
	jira();
	assert.equal(store.setting(store.getConnection('jira'), 'allowWrite'), false);
	assert.equal(store.setting(store.getConnection('jira'), 'requireApproval'), true);
	assert.equal((await dev('config', 'set', 'jira.allowWrite', 'yes')).status, 0);
	assert.equal(store.getConnection('jira').allowWrite, true);
	assert.match((await dev('config', 'set', 'jira.allowWrite', 'maybe')).output, /Use true or false/);
	assert.match((await dev('config', 'show')).output, /Allow write: yes\s+Require approval: yes/);
});

test('graph connections have no write settings', async () => {
	store.saveConnection({ type: 'graph', tenantId: '11111111-1111-1111-1111-111111111111', clientId: '22222222-2222-2222-2222-222222222222' });
	assert.match((await dev('config', 'set', 'graph.allowWrite', 'true')).output, /Invalid field "allowWrite"/);
	assert.doesNotMatch((await dev('config', 'show')).output, /Allow write/);
});

test('a write on a read-only connection fails without a request', async () => {
	jira();
	const { status, output } = await dev('jira', 'comment', 'add', 'PROJ-1', 'Hello', '--approve');
	assert.equal(status, 1);
	assert.match(output, /Writes are disabled for the Jira connection "jira"/);
	assert.deepEqual(requests, []);
	assert.deepEqual(listPending(), []);
});

test('a write that requires approval is held until it is approved, then runs exactly once', async () => {
	jira({ allowWrite: true });
	const held = await dev('jira', 'comment', 'add', 'PROJ-1', 'Line one\nLine two', '--json');
	assert.equal(held.status, 2, held.output);
	const pending = JSON.parse(held.output);
	assert.equal(pending.status, 'pending_approval');
	assert.equal(pending.summary, 'Add a comment to PROJ-1');
	assert.equal(pending.details.Comment, 'Line one\nLine two');
	assert.equal(pending.approve, `dev pending approve ${pending.id}`);
	assert.deepEqual(writes(), []);

	const listed = JSON.parse((await dev('pending', 'list', '--json')).output);
	assert.deepEqual(listed.map((e) => e.id), [pending.id]);

	const approved = await dev('pending', 'approve', pending.id, '--plain');
	assert.equal(approved.status, 0, approved.output);
	assert.match(approved.output, /Added comment 100 to PROJ-1/);
	assert.deepEqual(writes().map((r) => [r.method, r.path, r.auth, r.body.body]), [
		['POST', '/rest/api/2/issue/PROJ-1/comment', 'Bearer jira-token', 'Line one\nLine two'],
	]);

	const again = await dev('pending', 'approve', pending.id);
	assert.equal(again.status, 1);
	assert.match(again.output, /No pending action/);
	assert.equal(writes().length, 1);
});

test('--approve and requireApproval false run a write at once', async () => {
	jira({ allowWrite: true });
	assert.equal((await dev('jira', 'comment', 'add', 'PROJ-1', 'Now', '--approve')).status, 0);
	store.setField('jira', 'requireApproval', 'false');
	assert.equal((await dev('jira', 'comment', 'add', 'PROJ-1', 'Also now')).status, 0);
	assert.deepEqual(writes().map((r) => r.body.body), ['Now', 'Also now']);
	assert.deepEqual(listPending(), []);
});

test('a changed request replaces the pending action the user asked to change', async () => {
	jira({ allowWrite: true });
	const first = JSON.parse((await dev('jira', 'comment', 'add', 'PROJ-1', 'Staging', '--json')).output);
	assert.match(first.message, new RegExp(`--replaces ${first.id}`));
	const second = JSON.parse((await dev('jira', 'comment', 'add', 'PROJ-1', 'Production', '--replaces', first.id, '--json')).output);
	assert.equal(second.replaced, first.id);
	assert.deepEqual(listPending().map((e) => e.id), [second.id]);
	assert.match((await dev('pending', 'approve', first.id)).output, /No pending action/);
	assert.deepEqual(writes(), []);
});

test('--replaces with an unknown ID stops before anything is held or sent', async () => {
	jira({ allowWrite: true });
	const { status, output } = await dev('jira', 'comment', 'add', 'PROJ-1', 'X', '--replaces', 'deadbeef');
	assert.equal(status, 1);
	assert.match(output, /No pending action "deadbeef"/);
	assert.deepEqual(listPending(), []);
});

test('a failed immediate write keeps the action it was meant to replace', async () => {
	jira({ allowWrite: true });
	const { id } = JSON.parse((await dev('jira', 'comment', 'add', 'PROJ-1', 'Old', '--json')).output);
	respond = () => [400, { errorMessages: ['Rejected'] }];
	assert.equal((await dev('jira', 'comment', 'add', 'PROJ-1', 'New', '--replaces', id, '--approve')).status, 1);
	assert.deepEqual(listPending().map((e) => e.id), [id]);
	respond = () => [201, { id: '100' }];
	const done = await dev('jira', 'comment', 'add', 'PROJ-1', 'New', '--replaces', id, '--approve', '--plain');
	assert.equal(done.status, 0, done.output);
	assert.match(done.output, new RegExp(`Replaced pending action ${id}`));
	assert.deepEqual(listPending(), []);
});

test('a rejected pending action never runs', async () => {
	jira({ allowWrite: true });
	const { id } = JSON.parse((await dev('jira', 'comment', 'add', 'PROJ-1', 'No', '--json')).output);
	assert.equal((await dev('pending', 'reject', id)).status, 0);
	assert.equal((await dev('pending', 'approve', id)).status, 1);
	assert.deepEqual(writes(), []);
});

test('approval re-checks that the connection still allows writes', async () => {
	jira({ allowWrite: true });
	const { id } = JSON.parse((await dev('jira', 'comment', 'add', 'PROJ-1', 'Later', '--json')).output);
	store.setField('jira', 'allowWrite', 'false');
	const { status, output } = await dev('pending', 'approve', id);
	assert.equal(status, 1);
	assert.match(output, /Writes are disabled/);
	assert.match(output, /still pending/);
	assert.deepEqual(writes(), []);
	assert.deepEqual(listPending().map((e) => e.id), [id]);
});

test('a server rejection keeps the action pending and shows the API error', async () => {
	jira({ allowWrite: true });
	const { id } = JSON.parse((await dev('jira', 'comment', 'add', 'PROJ-1', 'Bad', '--json')).output);
	respond = () => [400, { errorMessages: [], errors: { comment: 'Comment body can not be empty!' } }];
	const { status, output } = await dev('pending', 'approve', id);
	assert.equal(status, 1);
	assert.match(output, /comment: Comment body can not be empty!/);
	assert.deepEqual(listPending().map((e) => e.id), [id]);
});

test('a server error after sending drops the action so it cannot run twice', async () => {
	jira({ allowWrite: true });
	const { id } = JSON.parse((await dev('jira', 'comment', 'add', 'PROJ-1', 'Maybe', '--json')).output);
	respond = () => [502, { message: 'Bad gateway' }];
	const { status, output } = await dev('pending', 'approve', id);
	assert.equal(status, 1);
	assert.match(output, /outcome of action .* is unknown/);
	assert.deepEqual(listPending(), []);
});

test('approval refuses when the connection label now resolves to another site', async () => {
	jira({ allowWrite: true });
	store.saveConnection({ type: 'jira', name: 'other', baseUrl: 'http://127.0.0.1:9', token: 't', allowWrite: true });
	const { id } = JSON.parse((await dev('jira', 'comment', 'add', 'PROJ-1', 'Here', '--json')).output);
	store.removeConnection('jira');
	const { status, output } = await dev('pending', 'approve', id);
	assert.equal(status, 1);
	assert.match(output, /now points to http:\/\/127\.0\.0\.1:9/);
	assert.deepEqual(writes(), []);
});

test('a transition is resolved by name before approval', async () => {
	jira({ allowWrite: true, requireApproval: false });
	respond = (r) => r.method === 'GET'
		? [200, { transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress' } }, { id: '31', name: 'Finish', to: { name: 'Done' } }] }]
		: [204];
	const { status, output } = await dev('jira', 'transition', 'PROJ-1', 'done', '--plain');
	assert.equal(status, 0, output);
	assert.match(output, /Moved PROJ-1 to Done/);
	assert.deepEqual(writes().map((r) => [r.path, r.body]), [['/rest/api/2/issue/PROJ-1/transitions', { transition: { id: '31' } }]]);

	const missing = await dev('jira', 'transition', 'PROJ-1', 'Nope');
	assert.equal(missing.status, 1);
	assert.match(missing.output, /Available: Start \(11\) → In Progress, Finish \(31\) → Done/);
});

test('issue edits send only the given fields', async () => {
	jira({ allowWrite: true, requireApproval: false });
	respond = (r) => {
		if (r.path.endsWith('/editmeta')) return [200, { fields: { customfield_1: { name: 'Choice', schema: { type: 'option' } } } }];
		return r.method === 'GET' ? [200, { key: 'PROJ-1', fields: { summary: 'Old' } }] : [204];
	};
	const { status, output } = await dev('jira', 'edit', 'PROJ-1', '--summary', 'New', '--labels', 'a, b', '--unassign', '--field', 'customfield_1={"value":"x"}');
	assert.equal(status, 0, output);
	assert.deepEqual(writes()[0].body.fields, { summary: 'New', labels: ['a', 'b'], assignee: null, customfield_1: { value: 'x' } });
	assert.match((await dev('jira', 'edit', 'PROJ-1')).output, /Nothing to change/);
});

test('a --field that repeats a dedicated option is rejected', async () => {
	jira({ allowWrite: true, requireApproval: false });
	const { status, output } = await dev('jira', 'create', '--project', 'A', '--summary', 'X', '--field', 'summary=Y');
	assert.equal(status, 1);
	assert.match(output, /--field summary repeats a dedicated option/);
	assert.deepEqual(requests, []);
});

// A Jira 9 site whose Task create screen requires a plugin field.
function createScreen(r) {
	const path = r.path.split('?')[0];
	if (path === '/rest/api/2/serverInfo') return [200, { versionNumbers: [9, 4, 0] }];
	if (path === '/rest/api/2/issue/createmeta/PROJ/issuetypes') return [200, { startAt: 0, maxResults: 50, total: 1, values: [{ id: '3', name: 'Task' }] }];
	if (path === '/rest/api/2/issue/createmeta/PROJ/issuetypes/3') {
		return [200, { startAt: 0, maxResults: 50, total: 3, values: [
			{ fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } },
			{ fieldId: 'customfield_15300', name: 'Account', required: true, schema: { type: 'option2', custom: 'com.tempoplugin.tempo-accounts:accounts.customfield' } },
			{ fieldId: 'customfield_2', name: 'Story Points', required: false, schema: { type: 'number' } },
		] }];
	}
	if (path === '/rest/api/2/field') return [200, [{ id: 'customfield_77', name: 'Hidden' }]];
	return [201, { id: '1', key: 'PROJ-9' }];
}

test('a --field given by display name is coerced by its schema, and the preview shows what is sent', async () => {
	jira({ allowWrite: true });
	respond = createScreen;
	const held = await dev('jira', 'create', '--project', 'PROJ', '--summary', 'S', '--field', 'account=23533', '--field', 'Story Points=3', '--json');
	assert.equal(held.status, 2, held.output);
	const pending = JSON.parse(held.output);
	assert.equal(pending.details['Account (customfield_15300)'], '"23533"');
	assert.equal(pending.details['Story Points (customfield_2)'], '3');
	assert.deepEqual(writes(), []);

	assert.equal((await dev('pending', 'approve', pending.id)).status, 0);
	assert.deepEqual(writes()[0].body.fields, {
		project: { key: 'PROJ' }, issuetype: { name: 'Task' }, summary: 'S', customfield_15300: '23533', customfield_2: 3,
	});
});

test('a create without a required field, or with a value that does not fit, fails before it is held', async () => {
	jira({ allowWrite: true });
	respond = createScreen;
	const missing = await dev('jira', 'create', '--project', 'PROJ', '--summary', 'S');
	assert.equal(missing.status, 1);
	assert.match(missing.output, /Missing required field\(s\) for a Task in PROJ:\s+Account \(customfield_15300\): option2, com\.tempoplugin/);
	const misfit = await dev('jira', 'create', '--project', 'PROJ', '--summary', 'S', '--field', 'Account=1', '--field', 'Story Points=many');
	assert.equal(misfit.status, 1);
	assert.match(misfit.output, /Story Points \(customfield_2\) has type number; "many" is not a number/);
	const unknown = await dev('jira', 'create', '--project', 'PROJ', '--summary', 'S', '--field', 'Account=1', '--field', 'Nope=1');
	assert.match(unknown.output, /Unknown field "Nope"/);
	const hidden = await dev('jira', 'create', '--project', 'PROJ', '--summary', 'S', '--field', 'Account=1', '--field', 'hidden=1');
	assert.match(hidden.output, /Field Hidden \(customfield_77\) is not on the create screen/);
	assert.deepEqual(writes(), []);
	assert.deepEqual(listPending(), []);
});

test('jira view shows standard fields when set and custom fields by display name', async () => {
	jira();
	respond = () => [200, {
		key: 'PROJ-1',
		names: { customfield_15300: 'Account' },
		fields: {
			summary: 'S', created: '2026-01-01', updated: '2026-01-02',
			resolution: { name: 'Fixed' }, timetracking: { originalEstimate: '1d', remainingEstimate: '2h' },
			customfield_15300: { id: 23533, key: 'ACC', name: 'Internal' },
		},
	}];
	const { status, output } = await dev('jira', 'view', 'PROJ-1', '--fields', 'account', '--plain');
	assert.equal(status, 0, output);
	assert.match(output, /Resolution: Fixed/);
	assert.match(output, /Time tracking: original 1d, remaining 2h/);
	assert.doesNotMatch(output, /Due:/);
	assert.match(output, /Account \(customfield_15300\): Internal \(ACC\)/);
	const json = JSON.parse((await dev('jira', 'view', 'PROJ-1', '--all-fields', '--json')).output);
	assert.deepEqual(json.fields.find((f) => f.id === 'customfield_15300').raw, { id: 23533, key: 'ACC', name: 'Internal' });
	assert.equal(json.timeTracking.remainingEstimate, '2h');
});

test('dev api reads with the connection credentials and never prints them', async () => {
	jira();
	respond = () => [200, { name: 'me', startAt: 0, maxResults: 1, total: 2, values: [{ id: 1 }] }];
	const read = await dev('api', 'jira', '/rest/api/2/myself', '--query', 'expand=groups', '--select', 'name');
	assert.equal(read.status, 0, read.output);
	assert.match(read.output, /^"me"$/m);
	assert.match(read.output, /--all-pages/);
	assert.deepEqual(requests.map((r) => [r.method, r.path, r.auth]), [['GET', '/rest/api/2/myself?expand=groups', 'Bearer jira-token']]);

	respond = () => [401, { message: 'Unauthorized' }];
	for (const args of [['/rest/api/2/myself'], ['/rest/api/2/myself', '--json'], ['https://evil.example.invalid/x'], ['/rest/../x']]) {
		const { status, output } = await dev('api', 'jira', ...args);
		assert.equal(status, 1, output);
		assert.doesNotMatch(output, /jira-token|Bearer|Authorization/i);
	}
	assert.equal(requests.length, 3);
	assert.match((await dev('api', 'jira', '/rest/api/2/issue', '--post', '{}')).output, /--post is allowed only for read-only POST endpoints/);
	assert.equal(requests.length, 3);
});

test('a token from the environment is sent and never printed', async () => {
	store.saveConnection({ type: 'jira', baseUrl });
	respond = () => [200, { name: 'me' }];
	const read = await devWith({ DEV_JIRA_TOKEN: 'env-token' }, 'api', 'jira', '/rest/api/2/myself');
	assert.equal(read.status, 0, read.output);
	assert.equal(requests[0].auth, 'Bearer env-token');
	const shown = await devWith({ DEV_JIRA_TOKEN: 'env-token' }, 'config', 'show');
	assert.match(shown.output, /Token: env-•+ \(environment DEV_JIRA_TOKEN\)/);
	assert.doesNotMatch(shown.output, /env-token/);
});

test('Jira Server credentials answered as an anonymous user fail instead of returning empty data', async () => {
	jira();
	respond = () => [200, { issues: [], total: 0 }, { 'x-seraph-loginreason': 'AUTHENTICATED_FAILED' }];
	const { status, output } = await dev('jira', 'search', 'project = PROJ');
	assert.equal(status, 1);
	assert.match(output, /Authentication failed/);
});

test('a stalled request fails with a timeout instead of hanging', async () => {
	jira();
	respond = () => 'hang';
	const started = Date.now();
	const { status, output } = await devWith({ DEV_TIMEOUT: '1' }, 'api', 'jira', '/rest/api/2/myself');
	assert.equal(status, 1);
	assert.match(output, /timed out/);
	assert.ok(Date.now() - started < 10000);
	const viaSdk = await devWith({ DEV_TIMEOUT: '1' }, 'jira', 'view', 'PROJ-1');
	assert.match(viaSdk.output, /timed out/);
});

test('a held edit shows the current value of each field it changes', async () => {
	jira({ allowWrite: true });
	respond = (r) => {
		if (r.path.endsWith('/editmeta')) return [200, { fields: { customfield_2: { name: 'Story Points', schema: { type: 'number' } } } }];
		return [200, { key: 'PROJ-1', fields: { summary: 'Old title', description: 'Old line one\nOld line two', customfield_2: 3 } }];
	};
	const held = await dev('jira', 'edit', 'PROJ-1', '--summary', 'New title', '--description', 'New text', '--field', 'Story Points=5', '--json');
	assert.equal(held.status, 2, held.output);
	const { details } = JSON.parse(held.output);
	assert.equal(details.Summary, 'Old title → New title');
	assert.equal(details['Story Points (customfield_2)'], '3 → 5');
	assert.equal(details['Description (current)'], 'Old line one\nOld line two');
	assert.equal(details['Description (new)'], 'New text');
	assert.deepEqual(writes(), []);
});

test('work is logged with the time, start, and estimate held for approval', async () => {
	jira({ allowWrite: true });
	respond = (r) => r.method === 'GET'
		? [200, { key: 'PROJ-1', fields: { summary: 'S', timetracking: { remainingEstimate: '4h' } } }]
		: [201, { id: '77' }];
	const held = await dev('jira', 'worklog', 'add', 'PROJ-1', '1h 30m', '--started', '2026-10-28 13:30', '-m', 'Review', '--remaining', '2h', '--json');
	assert.equal(held.status, 2, held.output);
	const pending = JSON.parse(held.output);
	assert.equal(pending.summary, 'Log 1h 30m on PROJ-1');
	assert.match(pending.details.Started, /^2026-10-28T13:30:00\.000[+-]\d{4}$/);
	assert.equal(pending.details['Remaining estimate'], 'set to 2h (now 4h)');
	const approved = await dev('pending', 'approve', pending.id, '--plain');
	assert.equal(approved.status, 0, approved.output);
	const [post] = writes();
	assert.equal(post.path, '/rest/api/2/issue/PROJ-1/worklog?adjustEstimate=new&newEstimate=2h');
	assert.deepEqual({ ...post.body, started: undefined }, { timeSpent: '1h 30m', comment: 'Review', started: undefined });
	assert.match((await dev('jira', 'worklog', 'add', 'PROJ-1', 'soon')).output, /not a Jira duration/);
});

test('a requested field the view already shows is not printed twice', async () => {
	jira();
	respond = () => [200, { key: 'PROJ-1', names: { timetracking: 'Time tracking' }, fields: { summary: 'S', timetracking: { originalEstimate: '1d' } } }];
	const { output } = await dev('jira', 'view', 'PROJ-1', '--fields', 'Time tracking', '--plain');
	assert.equal(output.match(/original 1d/g).length, 1, output);
});

test('a held comment edit previews the current text read by ID', async () => {
	jira({ allowWrite: true });
	respond = () => [200, { id: '5', author: { displayName: 'Ann' }, body: 'Old text' }];
	const { output } = await dev('jira', 'comment', 'edit', 'PROJ-1', '5', 'New text', '--json');
	const pending = JSON.parse(output);
	assert.equal(pending.details['Current text'], 'Old text');
	assert.deepEqual(requests.map((r) => [r.method, r.path]), [['GET', '/rest/api/2/issue/PROJ-1/comment/5']]);
});

test('a write that runs at once skips the preview reads', async () => {
	jira({ allowWrite: true, requireApproval: false });
	respond = () => [204];
	assert.equal((await dev('jira', 'comment', 'delete', 'PROJ-1', '5')).status, 0);
	assert.deepEqual(requests.map((r) => r.method), ['DELETE']);
});

test('a held merge refuses when the head or destination changed after the preview', async (t) => {
	const bitbucket = { type: 'bitbucket', workspace: 'ws', email: 'e', token: 't' };
	const params = { id: '4', repo: 'r', commit: 'aaa', destination: 'develop' };
	let current;
	t.mock.method(globalThis, 'fetch', async () => Response.json(current));
	current = { source: { commit: { hash: 'aaa' } }, destination: { branch: { name: 'develop' } } };
	await mergeAction.verify(bitbucket, params);
	current = { source: { commit: { hash: 'aaa' } }, destination: { branch: { name: 'main' } } };
	await assert.rejects(mergeAction.verify(bitbucket, params), /changed after the preview/);
	current = { source: { commit: { hash: 'bbb' } }, destination: { branch: { name: 'develop' } } };
	await assert.rejects(mergeAction.verify(bitbucket, params), /changed after the preview/);
});

test('plain text converts to ADF and Confluence storage format', () => {
	assert.deepEqual(textToAdf('One\ntwo\n\n\nThree'), {
		type: 'doc',
		version: 1,
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: 'One' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }] },
			{ type: 'paragraph', content: [{ type: 'text', text: 'Three' }] },
		],
	});
	assert.equal(textToStorage('a < b\nc\n\nd & e'), '<p>a &lt; b<br />c</p><p>d &amp; e</p>');
});

const cloud = { type: 'confluence', baseUrl: 'https://example.atlassian.net', email: 'test@example.invalid', token: 't' };

test('Confluence page updates send the next version of the version they were prepared against', async (t) => {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls.push({ url: url.toString(), method: options.method, body: JSON.parse(options.body) });
		return Response.json({ id: '5' });
	});
	await updatePage(cloud, '5', { title: 'T', body: '<p>x</p>', version: 7, message: 'why' });
	assert.deepEqual(calls, [{
		url: 'https://example.atlassian.net/wiki/api/v2/pages/5',
		method: 'PUT',
		body: { id: '5', status: 'current', title: 'T', body: { representation: 'storage', value: '<p>x</p>' }, version: { number: 8, message: 'why' } },
	}]);
});

test('Confluence page creation resolves a space key to its ID', async (t) => {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls.push([options.method, url.pathname + url.search]);
		return Response.json(url.pathname.endsWith('/spaces') ? { results: [{ id: '42' }] } : { id: '9', title: 'T' });
	});
	await createPage(cloud, { spaceKey: 'DEV', title: 'T', body: '<p>x</p>' });
	assert.deepEqual(calls, [['GET', '/wiki/api/v2/spaces?keys=DEV'], ['POST', '/wiki/api/v2/pages']]);
});

const sd = { type: 'serviceDesk', baseUrl: 'https://example.atlassian.net', email: 'test@example.invalid', token: 't' };

test('Service Desk comments are internal unless public, and edits accept an empty response', async (t) => {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls.push({ path: url.pathname, method: options.method, redirect: options.redirect, body: JSON.parse(options.body) });
		return url.pathname.includes('servicedeskapi') ? Response.json({ id: '7' }) : new Response(null, { status: 204 });
	});
	await addComment(sd, 'TUKI-1', 'Hi');
	await addComment(sd, 'TUKI-1', 'Hi', { isPublic: true });
	await editIssue(sd, 'TUKI-1', { summary: 'S' });
	assert.deepEqual(calls.map((c) => [c.method, c.path, c.redirect, c.body]), [
		['POST', '/rest/servicedeskapi/request/TUKI-1/comment', 'manual', { body: 'Hi', public: false }],
		['POST', '/rest/servicedeskapi/request/TUKI-1/comment', 'manual', { body: 'Hi', public: true }],
		['PUT', '/rest/api/3/issue/TUKI-1', 'manual', { fields: { summary: 'S' } }],
	]);
});

test('a Service Desk write that returns data rejects an empty response', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
	await assert.rejects(addComment(sd, 'TUKI-1', 'Hi'), /configuration error/);
});

test('a Bitbucket PR edit sends back the title, description, and reviewers it does not change', async (t) => {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls.push({ method: options.method, body: options.body && JSON.parse(options.body) });
		return Response.json({ title: 'Old', description: 'Keep', reviewers: [{ uuid: '{r1}' }, { uuid: '{r2}' }] });
	});
	await updatePullRequest({ workspace: 'ws', email: 'e', token: 't' }, 4, { repo: 'r', title: 'New' });
	assert.deepEqual(calls, [
		{ method: 'GET', body: undefined },
		{ method: 'PUT', body: { title: 'New', description: 'Keep', reviewers: [{ uuid: '{r1}' }, { uuid: '{r2}' }] } },
	]);
});

test('Bitbucket inline comments target the new line of a file', async (t) => {
	let sent;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		sent = { path: url.pathname, method: options.method, body: JSON.parse(options.body) };
		return Response.json({ id: 3 });
	});
	await addPullRequestComment({ workspace: 'ws', email: 'e', token: 't' }, 4, { repo: 'r', body: 'Nit', path: 'a.js', line: 10 });
	assert.deepEqual(sent, {
		path: '/2.0/repositories/ws/r/pullrequests/4/comments',
		method: 'POST',
		body: { content: { raw: 'Nit' }, inline: { path: 'a.js', to: 10 } },
	});
});
