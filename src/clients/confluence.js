import { jsonInit, apiError } from '../utils/http.js';
import { deploymentOf } from '../utils/deployment.js';

async function connect({ baseUrl, email, token }) {
	const base = new URL(baseUrl);
	const kind = await deploymentOf(base.origin);
	// Cloud always serves Confluence under /wiki; Server/Data Center keeps its own context path.
	const path = kind === 'cloud' ? '/wiki' : base.pathname.replace(/\/+$/, '');
	return { kind, origin: base.origin, path, email, token };
}

// The base URL and authentication that `dev api` sends raw read requests with: the context path on
// Server/Data Center, /wiki on Cloud.
export async function apiTarget(connection) {
	const conn = await connect(connection);
	return { base: new URL(`${conn.origin}${conn.path}`), headers: { 'Authorization': authHeader(conn) } };
}

function apiUrl(conn, path) {
	return new URL(`${conn.origin}${conn.path}${path}`);
}

// Cloud v2 links are origin-relative, Server/Data Center links are relative to the context path.
function nextUrl(conn, link, current) {
	const contextRelative = conn.kind === 'server'
		&& link.startsWith('/') && !link.startsWith('//')
		&& !(conn.path && link.startsWith(`${conn.path}/`));
	return contextRelative ? apiUrl(conn, link) : new URL(link, current);
}

// Server/Data Center personal access tokens use Bearer auth; a username switches to Basic.
function authHeader({ kind, email = '', token = '' }) {
	if (kind === 'server' && !email) return `Bearer ${token}`;
	return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function request(conn, url, params = {}, { method = 'GET', body } = {}) {
	if (url.origin !== conn.origin) {
		throw new Error('Confluence pagination points to a different site. Check the base URL of the Confluence connection.');
	}
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null) url.searchParams.set(k, v);
	}

	const res = await fetch(url, jsonInit({ method, body, headers: { 'Authorization': authHeader(conn) } }));
	if (!res.ok) throw await apiError('Confluence', res, url);
	if (res.status === 204) return null;

	// Server/Data Center answers rejected credentials with a login page instead of a 401.
	if (!res.headers.get('content-type')?.includes('json')) {
		const err = new Error('Confluence returned a non-JSON response. Check the base URL and token of the Confluence connection.');
		err.url = url.toString();
		throw err;
	}

	return res.json();
}

async function paginate(conn, path, params = {}) {
	const results = [];
	let url = apiUrl(conn, path);
	let data = await request(conn, url, params);
	results.push(...(data.results || []));

	while (data._links?.next) {
		url = nextUrl(conn, data._links.next, url);
		data = await request(conn, url);
		results.push(...(data.results || []));
	}

	return results;
}

// Server/Data Center v1 content is reshaped to the Cloud v2 fields the formatters read.
function serverSpace(space) {
	return {
		id: String(space.id),
		key: space.key,
		name: space.name,
		type: space.type,
		status: space.status,
	};
}

function serverPage(page) {
	return {
		id: page.id,
		title: page.title,
		status: page.status,
		spaceId: page.space?.id != null ? String(page.space.id) : undefined,
		...(page.space?.key && { space: { key: page.space.key, ...(page.space.name && { name: page.space.name }) } }),
		createdAt: page.history?.createdDate,
		version: page.version ? {
			number: page.version.number,
			...(page.version.by && { author: page.version.by.displayName || page.version.by.username }),
			...(page.version.when && { createdAt: page.version.when }),
		} : undefined,
		body: page.body,
		...(page.metadata?.labels && { labels: (page.metadata.labels.results || []).map((l) => l.name) }),
		...(page.ancestors && { ancestors: page.ancestors.map((a) => ({ id: String(a.id), title: a.title })) }),
	};
}

// The content listing silently returns nothing for an unknown space key, so the space is looked up first.
async function serverSpaceKey(conn, { spaceId, spaceKey }) {
	if (!spaceKey) return (await spaces(conn)).find((s) => s.id === String(spaceId))?.key;
	try {
		return (await request(conn, apiUrl(conn, `/rest/api/space/${encodeURIComponent(spaceKey)}`))).key;
	} catch (err) {
		if (err.status === 404) return undefined;
		throw err;
	}
}

async function spaces(conn) {
	if (conn.kind === 'cloud') return paginate(conn, '/api/v2/spaces');
	return (await paginate(conn, '/rest/api/space', { limit: 100 })).map(serverSpace);
}

export async function listSpaces(connection) {
	return spaces(await connect(connection));
}

// Cloud v2 names the version author by account ID only; ancestors come as IDs, so their titles are read
// in one more request.
async function cloudPageDetails(conn, page) {
	const ancestorIds = (await paginate(conn, `/api/v2/pages/${page.id}/ancestors`)).map((a) => String(a.id));
	const space = page.spaceId ? await request(conn, apiUrl(conn, `/api/v2/spaces/${page.spaceId}`)).catch(() => null) : null;
	const titles = new Map();
	if (ancestorIds.length) {
		const found = await request(conn, apiUrl(conn, '/api/v2/pages'), { id: ancestorIds.join(','), limit: 250 });
		for (const p of found.results || []) titles.set(String(p.id), p.title);
	}
	return {
		...page,
		...(space && { space: { key: space.key, name: space.name } }),
		version: page.version && { ...page.version, author: page.version.authorId },
		labels: (page.labels?.results || []).map((l) => l.name),
		ancestors: ancestorIds.map((ancestor) => ({ id: ancestor, title: titles.get(ancestor) ?? null })),
	};
}

// With `details`, the page also carries its labels, ancestors (root first), and version author and date.
export async function getPage(connection, id, { details = false } = {}) {
	const conn = await connect(connection);
	if (conn.kind === 'cloud') {
		const page = await request(conn, apiUrl(conn, `/api/v2/pages/${id}`), {
			'body-format': 'storage',
			...(details && { 'include-labels': 'true', 'include-version': 'true' }),
		});
		return details ? cloudPageDetails(conn, page) : page;
	}
	return serverPage(await request(conn, apiUrl(conn, `/rest/api/content/${id}`), {
		expand: `body.storage,version,space,history${details ? ',ancestors,metadata.labels' : ''}`,
	}));
}

export async function listChildPages(connection, id) {
	const conn = await connect(connection);
	if (conn.kind === 'cloud') return paginate(conn, `/api/v2/pages/${id}/children`);
	return (await paginate(conn, `/rest/api/content/${id}/child/page`, { expand: 'version,history', limit: 100 })).map(serverPage);
}

export async function listAttachments(connection, pageId) {
	const conn = await connect(connection);
	if (conn.kind === 'cloud') {
		return (await paginate(conn, `/api/v2/pages/${pageId}/attachments`)).map((a) => ({
			id: a.id, title: a.title, fileSize: a.fileSize ?? null, mediaType: a.mediaType || null,
		}));
	}
	return (await paginate(conn, `/rest/api/content/${pageId}/child/attachment`, { limit: 100 })).map((a) => ({
		id: a.id, title: a.title, fileSize: a.extensions?.fileSize ?? null, mediaType: a.extensions?.mediaType || a.metadata?.mediaType || null,
	}));
}

async function cloudSpaceId(conn, { spaceId, spaceKey }) {
	return spaceId ?? (await request(conn, apiUrl(conn, '/api/v2/spaces'), { keys: spaceKey })).results?.[0]?.id;
}

// Cloud lists pages by space ID and Server/Data Center by space key; returns null for an unknown space.
export async function listSpacePages(connection, { spaceId, spaceKey }) {
	const conn = await connect(connection);
	if (conn.kind === 'cloud') {
		const id = await cloudSpaceId(conn, { spaceId, spaceKey });
		if (!id) return null;
		return paginate(conn, `/api/v2/spaces/${id}/pages`);
	}

	const key = await serverSpaceKey(conn, { spaceId, spaceKey });
	if (!key) return null;
	const pages = await paginate(conn, '/rest/api/content', {
		spaceKey: key,
		type: 'page',
		expand: 'version,history',
		limit: 100,
	});
	return pages.map(serverPage);
}

// Cloud v2 and Server v1 nest a storage-format body differently.
function cloudBody(value) {
	return { representation: 'storage', value };
}

function serverBody(value) {
	return { storage: { value, representation: 'storage' } };
}

function spaceNotFound({ spaceId, spaceKey }) {
	return new Error(`Confluence space "${spaceId || spaceKey}" not found`);
}

export async function createPage(connection, { spaceId, spaceKey, title, body, parentId }) {
	const conn = await connect(connection);
	if (conn.kind === 'cloud') {
		const id = await cloudSpaceId(conn, { spaceId, spaceKey });
		if (!id) throw spaceNotFound({ spaceId, spaceKey });
		return request(conn, apiUrl(conn, '/api/v2/pages'), {}, {
			method: 'POST',
			body: { spaceId: id, status: 'current', title, parentId, body: cloudBody(body) },
		});
	}
	const key = await serverSpaceKey(conn, { spaceId, spaceKey });
	if (!key) throw spaceNotFound({ spaceId, spaceKey });
	return serverPage(await request(conn, apiUrl(conn, '/rest/api/content'), {}, {
		method: 'POST',
		body: {
			type: 'page',
			title,
			space: { key },
			ancestors: parentId ? [{ id: parentId }] : undefined,
			body: serverBody(body),
		},
	}));
}

// `version` is the number the change was prepared against, so a concurrent edit fails with a conflict instead of being overwritten.
export async function updatePage(connection, id, { title, body, version, message }) {
	const conn = await connect(connection);
	const next = { number: version + 1, message };
	if (conn.kind === 'cloud') {
		return request(conn, apiUrl(conn, `/api/v2/pages/${id}`), {}, {
			method: 'PUT',
			body: { id, status: 'current', title, body: cloudBody(body), version: next },
		});
	}
	return serverPage(await request(conn, apiUrl(conn, `/rest/api/content/${id}`), {}, {
		method: 'PUT',
		body: { id, type: 'page', title, body: serverBody(body), version: next },
	}));
}

export async function deletePage(connection, id) {
	const conn = await connect(connection);
	const path = conn.kind === 'cloud' ? `/api/v2/pages/${id}` : `/rest/api/content/${id}`;
	await request(conn, apiUrl(conn, path), {}, { method: 'DELETE' });
}

function serverComment(comment) {
	return {
		id: comment.id,
		author: comment.history?.createdBy?.displayName || null,
		createdAt: comment.history?.createdDate || comment.version?.when || null,
		body: comment.body?.storage?.value || '',
	};
}

// Cloud comments name their author by account ID only.
function cloudComment(comment) {
	return {
		id: comment.id,
		author: comment.version?.authorId || null,
		createdAt: comment.version?.createdAt || null,
		body: comment.body?.storage?.value || '',
	};
}

export async function listPageComments(connection, pageId) {
	const conn = await connect(connection);
	if (conn.kind === 'cloud') {
		return (await paginate(conn, `/api/v2/pages/${pageId}/footer-comments`, { 'body-format': 'storage' })).map(cloudComment);
	}
	const comments = await paginate(conn, `/rest/api/content/${pageId}/child/comment`, {
		expand: 'body.storage,version,history',
		limit: 100,
	});
	return comments.map(serverComment);
}

export async function getPageComment(connection, id) {
	const conn = await connect(connection);
	if (conn.kind === 'cloud') {
		return cloudComment(await request(conn, apiUrl(conn, `/api/v2/footer-comments/${id}`), { 'body-format': 'storage' }));
	}
	return serverComment(await request(conn, apiUrl(conn, `/rest/api/content/${id}`), { expand: 'body.storage,version,history' }));
}

export async function addPageComment(connection, pageId, body) {
	const conn = await connect(connection);
	if (conn.kind === 'cloud') {
		return cloudComment(await request(conn, apiUrl(conn, '/api/v2/footer-comments'), {}, {
			method: 'POST',
			body: { pageId, body: cloudBody(body) },
		}));
	}
	return serverComment(await request(conn, apiUrl(conn, '/rest/api/content'), {}, {
		method: 'POST',
		body: { type: 'comment', container: { id: pageId, type: 'page' }, body: serverBody(body) },
	}));
}

export async function deletePageComment(connection, id) {
	const conn = await connect(connection);
	const path = conn.kind === 'cloud' ? `/api/v2/footer-comments/${id}` : `/rest/api/content/${id}`;
	await request(conn, apiUrl(conn, path), {}, { method: 'DELETE' });
}

export async function searchPages(connection, cql) {
	const conn = await connect(connection);
	const result = await request(conn, apiUrl(conn, '/rest/api/search'), { cql });
	return { ...result, totalSize: result.totalSize ?? result.totalCount };
}
