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
	['space pages', () => listSpacePages('123'), '/api/v2/spaces/123/pages'],
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
