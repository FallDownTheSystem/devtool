import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import store from './helpers/config.js';

const { searchIssues, getIssue, getIssueComments, listQueues } = await import('../src/clients/serviceDesk.js');

beforeEach(() => {
	store.set('serviceDesk.baseUrl', 'https://example.atlassian.net');
	store.set('serviceDesk.email', 'test@example.invalid');
	store.set('serviceDesk.token', 'test-token');
});

for (const data of [null, [], {}, { message: 'Sign in' }, { issues: null }, { issues: 'invalid' }, { issues: [], isLast: 'false' }, { issues: [], nextPageToken: 123 }]) {
	test(`search rejects invalid API response ${JSON.stringify(data)}`, async (t) => {
		t.mock.method(globalThis, 'fetch', async () => Response.json(data));
		await assert.rejects(searchIssues('project = TEST'), /Service Desk.*configuration.*response/i);
	});
}

test('search rejects a redirect instead of displaying empty results', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => {
		const response = Response.json({ issues: [], isLast: true });
		Object.defineProperty(response, 'redirected', { value: true });
		Object.defineProperty(response, 'url', { value: 'https://login.example.invalid' });
		return response;
	});
	await assert.rejects(searchIssues('project = TEST'), /Service Desk.*configuration.*redirect/i);
});

test('search rejects a vanity URL when serverInfo identifies a different canonical site', async (t) => {
	store.set('serviceDesk.baseUrl', 'https://jira.example.invalid');
	const paths = [];
	t.mock.method(globalThis, 'fetch', async (url) => {
		paths.push(url.pathname);
		return Response.json(url.pathname === '/rest/api/2/serverInfo'
			? { baseUrl: 'https://example.atlassian.net' }
			: { issues: [], isLast: true });
	});
	await assert.rejects(searchIssues('project = TEST'), /canonical.*https:\/\/example.atlassian.net/i);
	assert.deepEqual(paths, ['/rest/api/2/serverInfo']);
});

for (const [name, response] of [
	['HTML', () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } })],
	['invalid JSON', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
	['redirect', () => new Response(null, { status: 302, headers: { location: 'https://login.example.invalid' } })],
]) {
	test(`search reports a configuration error for ${name}`, async (t) => {
		t.mock.method(globalThis, 'fetch', async () => response());
		await assert.rejects(searchIssues('project = TEST'), /Service Desk configuration error/);
	});
}

test('search preserves HTTP authentication errors', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }));
	await assert.rejects(searchIssues('project = TEST'), { status: 401 });
});

test('search sends Basic authentication, prevents redirects, and preserves pagination', async (t) => {
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		assert.equal(url.pathname, '/rest/api/3/search/jql');
		assert.equal(url.searchParams.get('jql'), 'key = TEST-123');
		assert.equal(url.searchParams.get('maxResults'), '1');
		assert.equal(url.searchParams.get('nextPageToken'), 'opaque+/token');
		assert.equal(options.redirect, 'manual');
		assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('test@example.invalid:test-token').toString('base64'));
		return Response.json({ issues: [{ key: 'TEST-123' }], isLast: false, nextPageToken: 'second' });
	});
	assert.deepEqual(await searchIssues('key = TEST-123', 1, 'opaque+/token'), {
		issues: [{ key: 'TEST-123' }], isLast: false, nextPageToken: 'second', maxResults: 1,
	});
});

test('issue and comments requests accept their expected response shapes', async (t) => {
	t.mock.method(globalThis, 'fetch', async (url) => Response.json(url.pathname.endsWith('/comment')
		? { comments: [{ id: '1' }] }
		: { key: 'TEST-123', fields: { summary: 'Test issue' } }));
	assert.equal((await getIssue('TEST-123')).key, 'TEST-123');
	assert.deepEqual(await getIssueComments('TEST-123'), [{ id: '1' }]);
});

test('queues reject an invalid response instead of returning no queues', async (t) => {
	store.set('serviceDesk.defaultProject', 'TEST');
	t.mock.method(globalThis, 'fetch', async (url) => Response.json(url.pathname.endsWith('/queue')
		? {}
		: { values: [{ id: '1', projectKey: 'TEST' }] }));
	await assert.rejects(listQueues(), /Service Desk.*configuration.*response/i);
});

for (const url of ['', 'not-a-url', 'http://example.atlassian.net', 'https://example.atlassian.net/wiki', 'https://user:password@example.atlassian.net']) {
	test(`invalid base URL ${url} fails before any request`, async (t) => {
		store.set('serviceDesk.baseUrl', url);
		const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ issues: [] }));
		await assert.rejects(searchIssues('project = TEST'), /Service Desk configuration error/);
		assert.equal(fetch.mock.callCount(), 0);
	});
}

test('a custom host with a matching canonical URL works after an anonymous serverInfo check', async (t) => {
	store.set('serviceDesk.baseUrl', 'https://jira.example.invalid/');
	const paths = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		paths.push(url.pathname);
		if (url.pathname === '/rest/api/2/serverInfo') {
			assert.equal(options.headers.Authorization, undefined);
			return Response.json({ baseUrl: 'https://jira.example.invalid/' });
		}
		assert.ok(options.headers.Authorization.startsWith('Basic '));
		return Response.json({ issues: [], isLast: true });
	});
	assert.deepEqual((await searchIssues('project = TEST')).issues, []);
	assert.deepEqual(paths, ['/rest/api/2/serverInfo', '/rest/api/3/search/jql']);
});

test('queues preserve the project lookup and queue fields', async (t) => {
	store.set('serviceDesk.defaultProject', 'QUEUES');
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		assert.equal(options.headers['X-ExperimentalApi'], 'opt-in');
		return Response.json(url.pathname.endsWith('/queue')
			? { values: [{ id: '2', name: 'Open', jql: 'project = QUEUES' }] }
			: { values: [{ id: '3', projectKey: 'QUEUES' }] });
	});
	assert.deepEqual(await listQueues(), [{ id: '2', name: 'Open', jql: 'project = QUEUES' }]);
});

test('search accepts a genuine empty issue list', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => Response.json({ issues: [], isLast: true }));
	assert.deepEqual(await searchIssues('project = TEST'), {
		issues: [], nextPageToken: null, isLast: true, maxResults: 50,
	});
});
