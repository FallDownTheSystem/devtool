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
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, NO_COLOR: '1' } });
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
			const [status, data] = respond(entry);
			res.writeHead(status, { 'content-type': 'application/json' });
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
	respond = (r) => r.method === 'GET' ? [200, { key: 'PROJ-1', fields: { summary: 'Old' } }] : [204];
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
