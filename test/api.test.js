import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiUrl, select, parseSelect, nextPageUrl, collectAllPages } from '../src/utils/api.js';

const jira = new URL('https://jira.example.invalid');
const wiki = new URL('https://example.atlassian.net/wiki');
const bitbucket = new URL('https://api.bitbucket.org/2.0');

test('paths resolve under the base URL, keeping its context path and query', () => {
	assert.equal(apiUrl(jira, '/rest/api/2/issue/PROJ-1', [['fields', 'a,b']]).toString(), 'https://jira.example.invalid/rest/api/2/issue/PROJ-1?fields=a%2Cb');
	assert.equal(apiUrl(wiki, '/rest/api/content/1?expand=version').toString(), 'https://example.atlassian.net/wiki/rest/api/content/1?expand=version');
	assert.equal(apiUrl(bitbucket, '/repositories/ws/repo').toString(), 'https://api.bitbucket.org/2.0/repositories/ws/repo');
	// A dot inside a segment is not a dot segment.
	assert.equal(apiUrl(jira, '/rest/api/2/attachment/a..b').pathname, '/rest/api/2/attachment/a..b');
});

for (const path of [
	'https://evil.example.invalid/rest',
	'http://jira.example.invalid/rest',
	'rest/api/2/myself',
	'//evil.example.invalid/rest',
	'/\\evil.example.invalid',
	'/rest/../../secure',
	'/rest/api/..',
	'/rest/./api',
	'/rest/%2e%2e/secure',
	'/rest/%2E%2E%2Fsecure',
	'/rest/%252e%252e/secure',
	'/%2F%2Fevil.example.invalid',
	'/rest/%5c..%5cx',
	'/rest/%00',
	'/rest/%zz',
	'/rest#fragment',
	'/rest\napi',
	'',
]) {
	test(`path ${JSON.stringify(path)} is rejected`, () => {
		assert.throws(() => apiUrl(wiki, path), /Invalid path/);
	});
}

test('--select follows dot paths, maps arrays with [], and picks keys with {}', () => {
	const data = {
		total: 2,
		issues: [
			{ key: 'A-1', fields: { summary: 'One', status: { name: 'Open' } } },
			{ key: 'A-2', fields: { summary: 'Two', status: null } },
		],
	};
	assert.equal(select(data, 'total'), 2);
	assert.equal(select(data, 'issues.1.key'), 'A-2');
	assert.deepEqual(select(data, 'issues[].key'), ['A-1', 'A-2']);
	assert.deepEqual(select(data, 'issues[].fields.status.name'), ['Open', null]);
	assert.deepEqual(select(data, 'issues[].{key,fields.summary}'), [{ key: 'A-1', 'fields.summary': 'One' }, { key: 'A-2', 'fields.summary': 'Two' }]);
	assert.deepEqual(select([{ id: 1, name: 'a', schema: { type: 'string' }, x: 1 }], '[].{id,name,schema}'), [{ id: 1, name: 'a', schema: { type: 'string' } }]);
	// [] on an object maps its values, as editmeta keys fields by ID.
	assert.deepEqual(select({ fields: { a: { name: 'A' }, b: { name: 'B' } } }, 'fields[].name'), ['A', 'B']);
	assert.deepEqual(select(data, '{total,missing.path}'), { total: 2, 'missing.path': null });
	for (const bad of ['', '.a', 'a.', 'a..b', 'a[', 'a]', '{a', 'a{}', '{a,,b}']) {
		assert.throws(() => parseSelect(bad), /Invalid --select/, bad);
	}
});

test('next pages are found for every pagination style', () => {
	const at = (u) => new URL(u);
	// Jira Server: startAt/maxResults/total.
	assert.equal(nextPageUrl({ startAt: 0, maxResults: 2, total: 5, issues: [1, 2] }, at('https://jira.example.invalid/rest/api/2/search?jql=x'), jira).toString(),
		'https://jira.example.invalid/rest/api/2/search?jql=x&startAt=2');
	assert.equal(nextPageUrl({ startAt: 4, maxResults: 2, total: 5, issues: [5] }, at('https://jira.example.invalid/rest/api/2/search'), jira), null);
	// Jira Cloud: nextPageToken/isLast.
	assert.equal(nextPageUrl({ issues: [1], nextPageToken: 'abc', isLast: false }, at('https://x.atlassian.net/rest/api/3/search/jql?jql=y&nextPageToken=old'), new URL('https://x.atlassian.net')).toString(),
		'https://x.atlassian.net/rest/api/3/search/jql?jql=y&nextPageToken=abc');
	assert.equal(nextPageUrl({ issues: [1], nextPageToken: 'abc', isLast: true }, at('https://x.atlassian.net/a'), new URL('https://x.atlassian.net')), null);
	// Confluence v2: _links.next, origin-relative.
	assert.equal(nextPageUrl({ results: [1], _links: { next: '/wiki/api/v2/spaces?cursor=c' } }, at('https://example.atlassian.net/wiki/api/v2/spaces'), wiki).toString(),
		'https://example.atlassian.net/wiki/api/v2/spaces?cursor=c');
	// Confluence Server: _links.next relative to the context path.
	const server = new URL('https://intra.example.invalid/confluence');
	assert.equal(nextPageUrl({ results: [1], _links: { next: '/rest/api/space?start=25' } }, at('https://intra.example.invalid/confluence/rest/api/space'), server).toString(),
		'https://intra.example.invalid/confluence/rest/api/space?start=25');
	// Bitbucket: next as an absolute URL.
	assert.equal(nextPageUrl({ values: [1], next: 'https://api.bitbucket.org/2.0/repositories/ws?page=2' }, at('https://api.bitbucket.org/2.0/repositories/ws'), bitbucket).toString(),
		'https://api.bitbucket.org/2.0/repositories/ws?page=2');
	assert.equal(nextPageUrl({ values: [1] }, at('https://api.bitbucket.org/2.0/repositories/ws'), bitbucket), null);
});

for (const next of ['https://evil.example.invalid/2.0/x?page=2', '//evil.example.invalid/x', 'https://api.bitbucket.org/1.0/x']) {
	test(`a pagination link to ${next} is never followed`, async () => {
		const fetched = [];
		await assert.rejects(collectAllPages(async (url) => {
			fetched.push(url.toString());
			return { values: [1], next };
		}, new URL('https://api.bitbucket.org/2.0/repositories/ws'), bitbucket, 100), /outside the connection's site/);
		assert.equal(fetched.length, 1);
	});
}

test('--all-pages collects every page of startAt pagination and caps at the limit', async () => {
	const pages = (url) => {
		const startAt = Number(url.searchParams.get('startAt') || 0);
		return { startAt, maxResults: 2, total: 5, issues: [startAt + 1, startAt + 2].filter((n) => n <= 5) };
	};
	const all = await collectAllPages(async (url) => pages(url), new URL('https://jira.example.invalid/rest/api/2/search'), jira, 100);
	assert.deepEqual(all.data.issues, [1, 2, 3, 4, 5]);
	assert.equal(all.pages, 3);
	assert.equal(all.truncated, false);

	const capped = await collectAllPages(async (url) => pages(url), new URL('https://jira.example.invalid/rest/api/2/search'), jira, 3);
	assert.deepEqual(capped.data.issues, [1, 2, 3]);
	assert.equal(capped.truncated, true);
});

test('--all-pages follows cursors and removes them from the result', async () => {
	const responses = {
		'': { results: [1], _links: { next: '/wiki/api/v2/pages?cursor=2', base: 'b' } },
		'?cursor=2': { results: [2], _links: { next: '/wiki/api/v2/pages?cursor=3' } },
		'?cursor=3': { results: [3], _links: {} },
	};
	const all = await collectAllPages(async (url) => responses[url.search], new URL('https://example.atlassian.net/wiki/api/v2/pages'), wiki, 100);
	assert.deepEqual(all.data, { results: [1, 2, 3], _links: { base: 'b' } });

	const tokens = { '': { issues: ['a'], nextPageToken: 't1', isLast: false }, '?nextPageToken=t1': { issues: ['b'], isLast: true } };
	const cloud = new URL('https://x.atlassian.net');
	const jql = await collectAllPages(async (url) => tokens[url.search], new URL('https://x.atlassian.net/rest/api/3/search/jql'), cloud, 100);
	assert.deepEqual(jql.data, { issues: ['a', 'b'], isLast: true });
});
