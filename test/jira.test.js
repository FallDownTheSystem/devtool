import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import store from './helpers/config.js';
import { deployment, site, JIRA_TYPES } from '../src/clients/jira.js';
import { addComment } from '../src/clients/jiraCloud.js';
import { actions } from '../src/actions/index.js';
import { create, edit } from '../src/actions/jira.js';

beforeEach(() => store.default.set('connections', []));

test('the deployment comes from the setting, the connection type, the host, the email, or serverInfo', async (t) => {
	const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ deploymentType: 'Cloud' }));
	assert.equal(await deployment({ type: 'serviceDesk', baseUrl: 'https://x.example.invalid' }), 'cloud');
	assert.equal(await deployment({ type: 'jira', baseUrl: 'https://x.atlassian.net' }), 'cloud');
	assert.equal(await deployment({ type: 'jira', baseUrl: 'https://x.atlassian.net', deployment: 'server' }), 'server');
	// Jira Cloud cannot sign in without an email, so no email means Server/Data Center without a probe.
	assert.equal(await deployment({ type: 'jira', baseUrl: 'https://jira.example.invalid/jira', token: 't' }), 'server');
	assert.equal(fetch.mock.callCount(), 0);

	assert.equal(await deployment({ type: 'jira', baseUrl: 'https://cloud.example.invalid', email: 'e' }), 'cloud');
	assert.equal(fetch.mock.calls[0].arguments[0].toString(), 'https://cloud.example.invalid/rest/api/2/serverInfo');
	assert.equal(fetch.mock.calls[0].arguments[1].headers.Authorization, undefined);

	fetch.mock.mockImplementation(async () => Response.json({ deploymentType: 'DataCenter' }));
	assert.equal(await deployment({ type: 'jira', baseUrl: 'https://dc.example.invalid/jira', email: 'user' }), 'server');
	fetch.mock.mockImplementation(async () => { throw new TypeError('fetch failed'); });
	assert.equal(await deployment({ type: 'jira', baseUrl: 'https://down.example.invalid', email: 'user' }), 'server');

	await assert.rejects(site({ type: 'jira', baseUrl: 'https://x.atlassian.net', token: 't' }), /Jira Cloud signs in with your account email/);
});

test('an issue or project key picks the connection that lists the project', () => {
	store.saveConnection({ type: 'jira', baseUrl: 'https://jira.example.invalid', token: 'a', projects: 'proj, ops' });
	store.saveConnection({ type: 'serviceDesk', baseUrl: 'https://x.atlassian.net', email: 'e', token: 'b', defaultProject: 'TUKI' });
	store.saveConnection({ type: 'jira', name: 'cloud', baseUrl: 'https://x.atlassian.net', email: 'e', token: 'c', projects: 'SQTUKI' });
	assert.equal(store.getConnection('jira').projects, 'PROJ,OPS');
	assert.equal(store.getConnection(JIRA_TYPES, undefined, 'SQTUKI').token, 'c');
	assert.equal(store.getConnection(JIRA_TYPES, undefined, 'ops').token, 'a');
	// The default project routes as well.
	assert.equal(store.getConnection(JIRA_TYPES, undefined, 'TUKI').token, 'b');
	// Without a match, the default of the first type: dev jira prefers jira, dev sd prefers serviceDesk.
	assert.equal(store.getConnection(JIRA_TYPES, undefined, 'OTHER').token, 'a');
	assert.equal(store.getConnection(['serviceDesk', 'jira'], undefined, 'OTHER').token, 'b');
	// --connection wins over the project.
	assert.equal(store.getConnection(JIRA_TYPES, 'cloud', 'PROJ').token, 'c');
	assert.throws(() => store.getConnection(JIRA_TYPES, 'cloud-nope'), /No connection named/);

	store.setField('cloud', 'projects', 'SQTUKI,PROJ');
	assert.throws(() => store.getConnection(JIRA_TYPES, undefined, 'PROJ'), /Project PROJ is listed on several connections \(jira, cloud\)/);
	assert.throws(() => store.setField('cloud', 'projects', 'not a key'), /Enter project keys/);
	assert.throws(() => store.setField('cloud', 'deployment', 'maybe'), /Enter cloud or server/);
});

test('a Jira Cloud connection sends ADF and account IDs', async (t) => {
	const cloud = { type: 'jira', baseUrl: 'https://x.atlassian.net', email: 'e@example.invalid', token: 't' };
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls.push({ path: url.pathname, method: options.method, body: options.body && JSON.parse(options.body) });
		return Response.json({ id: '1', key: 'SQTUKI-1' });
	});
	await create.run(cloud, { project: 'SQTUKI', issueType: 'Task', summary: 'S', description: 'Line', assignee: '5b10ac', fields: {} });
	assert.deepEqual(calls[0], {
		path: '/rest/api/3/issue',
		method: 'POST',
		body: { fields: {
			project: { key: 'SQTUKI' }, issuetype: { name: 'Task' }, summary: 'S',
			description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Line' }] }] },
			assignee: { accountId: '5b10ac' },
		} },
	});
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls.push({ path: url.pathname, method: options.method, body: options.body && JSON.parse(options.body) });
		return new Response(null, { status: 204 });
	});
	await edit.run(cloud, { key: 'SQTUKI-1', assignee: '5b10ac', fields: {} });
	assert.deepEqual(calls[1], { path: '/rest/api/3/issue/SQTUKI-1', method: 'PUT', body: { fields: { assignee: { accountId: '5b10ac' } } } });
});

test('a Jira Cloud comment is internal through the issue API unless it is a public reply', async (t) => {
	const cloud = { type: 'jira', baseUrl: 'https://x.atlassian.net', email: 'e', token: 't' };
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls.push([url.pathname, JSON.parse(options.body)]);
		return Response.json({ id: '9' });
	});
	await addComment(cloud, 'SQTUKI-1', 'Note');
	await addComment(cloud, 'SQTUKI-1', 'Reply', { isPublic: true });
	assert.deepEqual(calls, [
		['/rest/api/3/issue/SQTUKI-1/comment', {
			body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Note' }] }] },
			properties: [{ key: 'sd.public.comment', value: { internal: true } }],
		}],
		['/rest/servicedeskapi/request/SQTUKI-1/comment', { body: 'Reply', public: true }],
	]);
});

test('pending actions held by earlier versions under sd.* names can still be approved', () => {
	for (const name of ['issue.create', 'issue.edit', 'issue.delete', 'issue.transition', 'comment.add', 'comment.edit', 'comment.delete']) {
		assert.equal(actions[`sd.${name}`], actions[`jira.${name}`], name);
	}
});
