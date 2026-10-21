import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import store from './helpers/config.js';

const { listSpaces, listSpacePages, getPage, searchPages } = await import('../src/clients/confluence.js');
const site = 'https://example.atlassian.net';

beforeEach(() => {
	store.set('confluence.baseUrl', site);
	store.set('confluence.email', 'test@example.invalid');
	store.set('confluence.token', 'test-token');
});

for (const [name, call, path] of [
	['spaces', listSpaces, '/api/v2/spaces'],
	['space pages', () => listSpacePages({ spaceId: '123' }), '/api/v2/spaces/123/pages'],
]) {
	for (const next of [`/wiki${path}?cursor=next`, `${site}/wiki${path}?cursor=next`, '?cursor=next']) {
		test(`${name} follows pagination link ${next}`, async (t) => {
			const urls = [];
			t.mock.method(globalThis, 'fetch', async (url) => {
				urls.push(url.toString());
				return Response.json(urls.length === 1
					? { results: [{ id: '1' }], _links: { next } }
					: { results: [{ id: '2' }] });
			});
			assert.deepEqual(await call(), [{ id: '1' }, { id: '2' }]);
			assert.deepEqual(urls, [`${site}/wiki${path}`, `${site}/wiki${path}?cursor=next`]);
		});
	}
}

for (const suffix of ['/', '///', '/wiki', '/wiki/']) {
	test(`base URL suffix ${suffix} does not duplicate the wiki prefix`, async (t) => {
		store.set('confluence.baseUrl', `${site}${suffix}`);
		t.mock.method(globalThis, 'fetch', async (url) => {
			assert.equal(url.toString(), `${site}/wiki/api/v2/spaces`);
			return Response.json({ results: [] });
		});
		assert.deepEqual(await listSpaces(), []);
	});
}

for (const next of ['https://other.example.invalid/wiki/api/v2/spaces', '//other.example.invalid/wiki/api/v2/spaces']) {
	test(`pagination cannot send credentials to ${next}`, async (t) => {
		const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [], _links: { next } }));
		await assert.rejects(listSpaces(), /different site/);
		assert.equal(fetch.mock.callCount(), 1);
	});
}

test('single-page and CQL requests preserve paths and parameters', async (t) => {
	const urls = [];
	t.mock.method(globalThis, 'fetch', async (url) => {
		urls.push(url.toString());
		return Response.json({ id: '123', results: [] });
	});
	assert.equal((await getPage('123')).id, '123');
	await searchPages('type = page');
	assert.deepEqual(urls, [
		`${site}/wiki/api/v2/pages/123?body-format=storage`,
		`${site}/wiki/rest/api/search?cql=type+%3D+page`,
	]);
});

// Each test uses its own host because the detected deployment is cached per origin.
let serverCount = 0;
function serverSite(t, routes, { tenant = null } = {}) {
	const origin = `https://confluence${++serverCount}.example.invalid`;
	const requests = [];
	t.mock.method(globalThis, 'fetch', async (url, init) => {
		url = new URL(url);
		if (url.pathname === '/_edge/tenant_info') {
			return tenant ? Response.json(tenant) : new Response('Not found', { status: 404 });
		}
		requests.push({ url: url.toString(), auth: init.headers.Authorization });
		const body = routes[url.pathname + url.search] ?? routes[url.pathname];
		if (body === undefined) return new Response('Not found', { status: 404 });
		return typeof body === 'string'
			? new Response(body, { headers: { 'content-type': 'text/html' } })
			: Response.json(body);
	});
	return { origin, requests };
}

test('server deployment keeps the context path, follows context-relative links, and uses Bearer auth', async (t) => {
	const { origin, requests } = serverSite(t, {
		'/confluence/rest/api/space?limit=100': {
			results: [{ id: 1, key: 'DEV', name: 'Dev', type: 'global' }],
			_links: { base: 'https://proxy.internal/confluence', context: '/confluence', next: '/rest/api/space?limit=100&start=100' },
		},
		'/confluence/rest/api/space?limit=100&start=100': { results: [{ id: 2, key: 'OPS', name: 'Ops' }] },
	});
	store.set('confluence.baseUrl', `${origin}/confluence/`);
	store.set('confluence.email', '');
	assert.deepEqual((await listSpaces()).map((s) => [s.id, s.key]), [['1', 'DEV'], ['2', 'OPS']]);
	assert.deepEqual(requests.map((r) => r.url), [
		`${origin}/confluence/rest/api/space?limit=100`,
		`${origin}/confluence/rest/api/space?limit=100&start=100`,
	]);
	assert.ok(requests.every((r) => r.auth === 'Bearer test-token'));
});

test('server deployment uses Basic auth when a username is set', async (t) => {
	const { origin, requests } = serverSite(t, { '/rest/api/space': { results: [] } });
	store.set('confluence.baseUrl', origin);
	await listSpaces();
	assert.equal(requests[0].auth, 'Basic ' + Buffer.from('test@example.invalid:test-token').toString('base64'));
});

test('server pages and page view are reshaped to the Cloud fields', async (t) => {
	const page = {
		id: '42', title: 'Runbook', status: 'current',
		space: { id: 7, key: 'DEV' },
		history: { createdDate: '2024-01-02T03:04:05.000Z' },
		version: { number: 3 },
		body: { storage: { value: '<p>Hello</p>' } },
	};
	const { origin, requests } = serverSite(t, {
		'/rest/api/content/42': page,
		'/rest/api/content': { results: [page] },
		'/rest/api/space': { results: [{ id: 7, key: 'DEV', name: 'Dev' }] },
		'/rest/api/space/DEV': { id: 7, key: 'DEV', name: 'Dev' },
	});
	store.set('confluence.baseUrl', origin);
	const expected = {
		id: '42', title: 'Runbook', status: 'current', spaceId: '7',
		createdAt: '2024-01-02T03:04:05.000Z', version: { number: 3 },
		body: { storage: { value: '<p>Hello</p>' } },
	};
	assert.deepEqual(await getPage('42'), expected);
	assert.deepEqual(await listSpacePages({ spaceKey: 'DEV' }), [expected]);
	assert.deepEqual(await listSpacePages({ spaceId: '7' }), [expected]);
	assert.equal(await listSpacePages({ spaceKey: 'NOPE' }), null);
	assert.equal(await listSpacePages({ spaceId: '999' }), null);
	assert.ok(requests.some((r) => r.url === `${origin}/rest/api/content?spaceKey=DEV&type=page&expand=version%2Chistory&limit=100`));
});

test('server search reads totalCount as totalSize', async (t) => {
	const { origin } = serverSite(t, { '/rest/api/search': { totalCount: 5, results: [] } });
	store.set('confluence.baseUrl', origin);
	assert.equal((await searchPages('type = page')).totalSize, 5);
});

test('server login pages are reported instead of failing to parse', async (t) => {
	const { origin } = serverSite(t, { '/rest/api/space': '<html>Log in</html>' });
	store.set('confluence.baseUrl', origin);
	await assert.rejects(listSpaces(), /non-JSON response/);
});

test('cloud sites on custom domains are detected through tenant_info', async (t) => {
	const { origin, requests } = serverSite(t, {
		'/wiki/api/v2/spaces?keys=DEV': { results: [{ id: '9', key: 'DEV' }] },
		'/wiki/api/v2/spaces/9/pages': { results: [{ id: '1' }] },
	}, { tenant: { cloudId: 'abc' } });
	store.set('confluence.baseUrl', origin);
	assert.deepEqual(await listSpacePages({ spaceKey: 'DEV' }), [{ id: '1' }]);
	assert.deepEqual(requests.map((r) => r.url), [
		`${origin}/wiki/api/v2/spaces?keys=DEV`,
		`${origin}/wiki/api/v2/spaces/9/pages`,
	]);
	assert.ok(requests[0].auth.startsWith('Basic '));
});
