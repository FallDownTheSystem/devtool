import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { listSpaces, listSpacePages, getPage, searchPages, downloadAttachment, uploadAttachment, saveDraft } from '../src/clients/confluence.js';
import { attachmentUpload, pageDraft } from '../src/actions/confluence.js';

const site = 'https://example.atlassian.net';
let connection;

beforeEach(() => {
	connection = { type: 'confluence', baseUrl: site, email: 'test@example.invalid', token: 'test-token' };
});

for (const [name, call, path] of [
	['spaces', () => listSpaces(connection), '/api/v2/spaces'],
	['space pages', () => listSpacePages(connection, { spaceId: '123' }), '/api/v2/spaces/123/pages'],
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
		connection.baseUrl = `${site}${suffix}`;
		t.mock.method(globalThis, 'fetch', async (url) => {
			assert.equal(url.toString(), `${site}/wiki/api/v2/spaces`);
			return Response.json({ results: [] });
		});
		assert.deepEqual(await listSpaces(connection), []);
	});
}

for (const next of ['https://other.example.invalid/wiki/api/v2/spaces', '//other.example.invalid/wiki/api/v2/spaces']) {
	test(`pagination cannot send credentials to ${next}`, async (t) => {
		const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [], _links: { next } }));
		await assert.rejects(listSpaces(connection), /different site/);
		assert.equal(fetch.mock.callCount(), 1);
	});
}

test('single-page and CQL requests preserve paths and parameters', async (t) => {
	const urls = [];
	t.mock.method(globalThis, 'fetch', async (url) => {
		urls.push(url.toString());
		return Response.json({ id: '123', results: [] });
	});
	assert.equal((await getPage(connection, '123')).id, '123');
	await searchPages(connection, 'type = page');
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
	connection.baseUrl = `${origin}/confluence/`;
	connection.email = '';
	assert.deepEqual((await listSpaces(connection)).map((s) => [s.id, s.key]), [['1', 'DEV'], ['2', 'OPS']]);
	assert.deepEqual(requests.map((r) => r.url), [
		`${origin}/confluence/rest/api/space?limit=100`,
		`${origin}/confluence/rest/api/space?limit=100&start=100`,
	]);
	assert.ok(requests.every((r) => r.auth === 'Bearer test-token'));
});

test('server deployment uses Basic auth when a username is set', async (t) => {
	const { origin, requests } = serverSite(t, { '/rest/api/space': { results: [] } });
	connection.baseUrl = origin;
	await listSpaces(connection);
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
	connection.baseUrl = origin;
	const expected = {
		id: '42', title: 'Runbook', status: 'current', spaceId: '7', space: { key: 'DEV' },
		createdAt: '2024-01-02T03:04:05.000Z', version: { number: 3 },
		body: { storage: { value: '<p>Hello</p>' } },
	};
	assert.deepEqual(await getPage(connection, '42'), expected);
	assert.deepEqual(await listSpacePages(connection, { spaceKey: 'DEV' }), [expected]);
	assert.deepEqual(await listSpacePages(connection, { spaceId: '7' }), [expected]);
	assert.equal(await listSpacePages(connection, { spaceKey: 'NOPE' }), null);
	assert.equal(await listSpacePages(connection, { spaceId: '999' }), null);
	assert.ok(requests.some((r) => r.url === `${origin}/rest/api/content?spaceKey=DEV&type=page&expand=version%2Chistory&limit=100`));
});

test('server search reads totalCount as totalSize', async (t) => {
	const { origin } = serverSite(t, { '/rest/api/search': { totalCount: 5, results: [] } });
	connection.baseUrl = origin;
	assert.equal((await searchPages(connection, 'type = page')).totalSize, 5);
});

test('server login pages are reported instead of failing to parse', async (t) => {
	const { origin } = serverSite(t, { '/rest/api/space': '<html>Log in</html>' });
	connection.baseUrl = origin;
	await assert.rejects(listSpaces(connection), /non-JSON response/);
});

test('cloud sites on custom domains are detected through tenant_info', async (t) => {
	const { origin, requests } = serverSite(t, {
		'/wiki/api/v2/spaces?keys=DEV': { results: [{ id: '9', key: 'DEV' }] },
		'/wiki/api/v2/spaces/9/pages': { results: [{ id: '1' }] },
	}, { tenant: { cloudId: 'abc' } });
	connection.baseUrl = origin;
	assert.deepEqual(await listSpacePages(connection, { spaceKey: 'DEV' }), [{ id: '1' }]);
	assert.deepEqual(requests.map((r) => r.url), [
		`${origin}/wiki/api/v2/spaces?keys=DEV`,
		`${origin}/wiki/api/v2/spaces/9/pages`,
	]);
	assert.ok(requests[0].auth.startsWith('Basic '));
});

const directory = mkdtempSync(join(tmpdir(), 'devtool-confluence-'));
after(() => rmSync(directory, { recursive: true, force: true }));

// Answers each request from `routes` by full URL; a function route gets the request and returns a Response.
function cloudFetch(t, routes) {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
		url = url.toString();
		calls.push({ url, method: init.method || 'GET', auth: init.headers?.Authorization, headers: init.headers, redirect: init.redirect, body: init.body });
		const route = routes[url];
		if (route === undefined) return new Response('Not found', { status: 404 });
		return typeof route === 'function' ? route(init) : route.clone();
	});
	return calls;
}

const attachmentMeta = Response.json({ id: 'att9', title: 'report.pdf', pageId: '42' });
const v1Download = `${site}/wiki/rest/api/content/42/child/attachment/att9/download`;

test('Cloud attachment download follows the media redirect without credentials and never overwrites', async (t) => {
	const media = 'https://api.media.atlassian.com/file/abc/binary?token=signed&dl=true';
	const calls = cloudFetch(t, {
		[`${site}/wiki/api/v2/attachments/att9`]: attachmentMeta,
		[v1Download]: new Response(null, { status: 302, headers: { location: media } }),
		[media]: new Response('pdf bytes'),
	});
	const destination = join(directory, 'report.pdf');
	const result = await downloadAttachment(connection, 'att9', destination);
	assert.deepEqual(result, { id: 'att9', title: 'report.pdf', path: destination, size: 9 });
	assert.equal(readFileSync(destination, 'utf8'), 'pdf bytes');
	assert.deepEqual(calls.map((c) => [c.url, Boolean(c.auth), c.redirect]), [
		[`${site}/wiki/api/v2/attachments/att9`, true, undefined],
		[v1Download, true, 'manual'],
		[media, false, 'manual'],
	]);

	await assert.rejects(downloadAttachment(connection, 'att9', destination), { code: 'EEXIST' });
	assert.equal(calls.length, 3);
	assert.equal(readFileSync(destination, 'utf8'), 'pdf bytes');
});

for (const location of [
	'https://evil.example.invalid/file',
	'http://api.media.atlassian.com/file/abc/binary',
	'https://api.media.atlassian.com.evil.example.invalid/file',
	'https://user:pass@api.media.atlassian.com/file',
	'https://example.atlassian.com/file',
]) {
	test(`Cloud attachment download refuses a redirect to ${location}`, async (t) => {
		const calls = cloudFetch(t, {
			[`${site}/wiki/api/v2/attachments/att9`]: attachmentMeta,
			[v1Download]: new Response(null, { status: 302, headers: { location } }),
		});
		const destination = join(directory, `refused-${calls.length}-${Math.random()}.bin`);
		await assert.rejects(downloadAttachment(connection, 'att9', destination), /Refused a download redirect/);
		assert.equal(calls.length, 2);
		assert.equal(existsSync(destination), false);
	});
}

test('a redirect from the media service back to the site is refused, so credentials are not sent again', async (t) => {
	const media = 'https://api.media.atlassian.com/file/abc/binary?token=signed';
	const calls = cloudFetch(t, {
		[`${site}/wiki/api/v2/attachments/att9`]: attachmentMeta,
		[v1Download]: new Response(null, { status: 302, headers: { location: media } }),
		[media]: new Response(null, { status: 302, headers: { location: `${site}/wiki/other` } }),
	});
	await assert.rejects(downloadAttachment(connection, 'att9', join(directory, 'bounce.bin')), /Refused a download redirect/);
	assert.equal(calls.length, 3);
});

test('Server attachment download reads the context-relative download link with the site credentials', async (t) => {
	const { origin, requests } = serverSite(t, {
		'/confluence/rest/api/content/att7': { id: 'att7', type: 'attachment', title: 'notes.txt', _links: { download: '/download/attachments/42/notes.txt?version=1&api=v2' } },
		'/confluence/download/attachments/42/notes.txt': { note: 'bytes' },
	});
	connection.baseUrl = `${origin}/confluence`;
	connection.email = '';
	const destination = join(directory, 'notes.txt');
	await downloadAttachment(connection, 'att7', destination);
	assert.equal(readFileSync(destination, 'utf8'), '{"note":"bytes"}');
	assert.deepEqual(requests.map((r) => [r.url, r.auth]), [
		[`${origin}/confluence/rest/api/content/att7`, 'Bearer test-token'],
		[`${origin}/confluence/download/attachments/42/notes.txt?version=1&api=v2`, 'Bearer test-token'],
	]);
});

test('Server attachment download reports a redirect to the login page', async (t) => {
	const { origin } = serverSite(t, {
		'/rest/api/content/att7': { id: 'att7', type: 'attachment', title: 'notes.txt', _links: { download: '/download/attachments/42/notes.txt' } },
	});
	t.mock.method(globalThis, 'fetch', async (url) => {
		url = new URL(url);
		if (url.pathname === '/_edge/tenant_info') return new Response('', { status: 404 });
		if (url.pathname === '/rest/api/content/att7') return Response.json({ id: 'att7', type: 'attachment', title: 'notes.txt', _links: { download: '/download/attachments/42/notes.txt' } });
		return new Response(null, { status: 302, headers: { location: `${origin}/login.action?os_destination=x` } });
	});
	connection.baseUrl = origin;
	await assert.rejects(downloadAttachment(connection, 'att7', join(directory, 'login.txt')), /login page/);
	assert.equal(existsSync(join(directory, 'login.txt')), false);
});

test('attachment upload posts a multipart file with the XSRF token header and returns the new attachment', async (t) => {
	const url = `${site}/wiki/rest/api/content/42/child/attachment`;
	const calls = cloudFetch(t, { [url]: Response.json({ results: [{ id: 'att10', title: 'data.csv' }] }) });
	const result = await uploadAttachment(connection, '42', { name: 'data.csv', data: Buffer.from('a,b\n1,2\n') });
	assert.deepEqual(result, { id: 'att10', title: 'data.csv', version: null });
	assert.equal(calls[0].method, 'POST');
	assert.equal(calls[0].headers['X-Atlassian-Token'], 'nocheck');
	assert.equal(calls[0].headers['Content-Type'], undefined);
	const file = calls[0].body.get('file');
	assert.equal(file.name, 'data.csv');
	assert.equal(await file.text(), 'a,b\n1,2\n');
	assert.equal(calls[0].body.get('minorEdit'), 'true');
});

function uploadFixture(t, attachments = []) {
	const path = join(directory, `upload-${Math.random()}.txt`);
	writeFileSync(path, 'first');
	const uploads = [];
	cloudFetch(t, {
		[`${site}/wiki/api/v2/pages/42/attachments`]: () => Response.json({ results: attachments }),
		[`${site}/wiki/rest/api/content/42/child/attachment`]: async (init) => {
			uploads.push(await init.body.get('file').text());
			return Response.json({ results: [{ id: 'att11', title: init.body.get('file').name }] });
		},
	});
	return { path, uploads };
}

test('an upload is prepared with a hash of the file and refuses a name the page already has', async (t) => {
	const { path } = uploadFixture(t, [{ id: 'att1', title: 'taken.txt' }]);
	const params = await attachmentUpload.prepare(connection, { pageId: '42', file: path });
	assert.equal(params.name, basename(path));
	assert.equal(params.size, 5);
	assert.match(params.sha256, /^[0-9a-f]{64}$/);
	await assert.rejects(attachmentUpload.prepare(connection, { pageId: '42', file: path, name: 'taken.txt' }), /already has an attachment named "taken.txt"/);
	await assert.rejects(attachmentUpload.prepare(connection, { pageId: '42', file: path, name: '../x.txt' }), /Invalid attachment name/);
});

test('an upload sends the previewed bytes and refuses a file changed after the preview', async (t) => {
	const { path, uploads } = uploadFixture(t);
	const params = await attachmentUpload.prepare(connection, { pageId: '42', file: path, name: 'kept.txt' });
	await attachmentUpload.verify(connection, params);
	const result = await attachmentUpload.run(connection, params);
	assert.deepEqual(result, { id: 'att11', title: 'kept.txt', version: null });
	assert.equal(attachmentUpload.report(result, params).failed, false);
	assert.deepEqual(uploads, ['first']);

	writeFileSync(path, 'second');
	await assert.rejects(attachmentUpload.verify(connection, params), (err) => err.stale && /changed after the preview/.test(err.message));
	await assert.rejects(attachmentUpload.run(connection, params), /changed after the preview/);
	assert.deepEqual(uploads, ['first']);
});

test('approval of an upload fails when the name was taken after the preview', async (t) => {
	const attachments = [];
	const { path } = uploadFixture(t, attachments);
	const params = await attachmentUpload.prepare(connection, { pageId: '42', file: path, name: 'late.txt' });
	attachments.push({ id: 'att2', title: 'late.txt' });
	await assert.rejects(attachmentUpload.verify(connection, params), (err) => err.stale && /already has an attachment/.test(err.message));
});

test('an upload that Confluence stored as a new version of an existing attachment is reported as failed', () => {
	const report = attachmentUpload.report({ id: 'att3', title: 'a.txt', version: 2 }, { pageId: '42', name: 'a.txt', size: 1 });
	assert.equal(report.failed, true);
	assert.match(report.message, /version 2 of the existing attachment att3/);
});

test('a media service error does not show the signed token', async (t) => {
	const media = 'https://api.media.atlassian.com/file/abc/binary?token=signed-secret';
	cloudFetch(t, {
		[`${site}/wiki/api/v2/attachments/att9`]: attachmentMeta,
		[v1Download]: new Response(null, { status: 302, headers: { location: media } }),
		[media]: new Response('expired', { status: 403 }),
	});
	await assert.rejects(downloadAttachment(connection, 'att9', join(directory, 'expired.bin')), (err) => {
		assert.equal(err.status, 403);
		assert.equal(err.url, 'https://api.media.atlassian.com/file/abc/binary');
		return true;
	});
});

test('relative redirects stay on the site with credentials, and the redirect limit holds', async (t) => {
	let hops = 0;
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
		url = url.toString();
		calls.push({ url, auth: init.headers?.Authorization });
		if (url.endsWith('/attachments/att9')) return attachmentMeta.clone();
		return new Response(null, { status: 302, headers: { location: `/wiki/hop?n=${++hops}` } });
	});
	await assert.rejects(downloadAttachment(connection, 'att9', join(directory, 'loop.bin')), /too many times/);
	assert.ok(calls.slice(1).every((c) => c.url.startsWith(`${site}/wiki/`) && c.auth));
	assert.equal(calls.length, 1 + 6);
});

test('a download into a missing folder fails before any request', async (t) => {
	const calls = cloudFetch(t, {});
	await assert.rejects(downloadAttachment(connection, 'att9', join(directory, 'missing', 'x.bin')), /folder does not exist/);
	assert.equal(calls.length, 0);
});

test('approval of a draft fails when the page was published again after the preview', async (t) => {
	let version = 7;
	cloudFetch(t, {
		[`${site}/wiki/api/v2/pages/5?body-format=storage`]: () => Response.json({ id: '5', title: 'Runbook', status: 'current', version: { number: version }, body: { storage: { value: '<p>old</p>' } } }),
	});
	const params = await pageDraft.prepare(connection, { id: '5', title: 'New title' });
	await pageDraft.verify(connection, params);
	version = 8;
	await assert.rejects(pageDraft.verify(connection, params), (err) => err.stale && /7 → 8/.test(err.message));
});

test('a draft of a published page is saved with version 1 and leaves the published version alone', async (t) => {
	const page = `${site}/wiki/api/v2/pages/5`;
	const calls = cloudFetch(t, {
		[`${page}?body-format=storage`]: Response.json({ id: '5', title: 'Runbook', status: 'current', version: { number: 7 }, body: { storage: { value: '<p>old</p>' } } }),
		[page]: Response.json({ id: '5', status: 'draft' }),
	});
	const params = await pageDraft.prepare(connection, { id: '5', body: '<p>new</p>', message: 'why' });
	assert.equal(params.version, 7);
	assert.match(pageDraft.report(await pageDraft.run(connection, params), params).message, /published version 7 is not changed/);
	const put = calls.find((c) => c.method === 'PUT');
	assert.deepEqual(JSON.parse(put.body), {
		id: '5', status: 'draft', title: 'Runbook', body: { representation: 'storage', value: '<p>new</p>' }, version: { number: 1, message: 'why' },
	});
});

test('a draft is refused for an unpublished page and on Server/Data Center', async (t) => {
	cloudFetch(t, {
		[`${site}/wiki/api/v2/pages/6?body-format=storage`]: Response.json({ id: '6', title: 'New', status: 'draft', version: { number: 1 } }),
	});
	await assert.rejects(pageDraft.prepare(connection, { id: '6', body: '<p>x</p>' }), /not published/);
	t.mock.restoreAll();

	const { origin, requests } = serverSite(t, {});
	connection.baseUrl = origin;
	await assert.rejects(pageDraft.prepare(connection, { id: '6', body: '<p>x</p>' }), /only on Confluence Cloud/);
	await assert.rejects(saveDraft(connection, '6', { title: 'T', body: '<p>x</p>' }), /no REST API/);
	assert.deepEqual(requests, []);
});
