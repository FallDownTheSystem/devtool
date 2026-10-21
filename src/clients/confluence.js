import { get } from '../config/store.js';

const deployments = new Map();

// Custom domains hide the atlassian.net hostname, so anything else is probed:
// Atlassian's edge answers tenant_info anonymously, Server/Data Center does not.
async function detectDeployment(origin) {
	if (/\.atlassian\.net$/i.test(new URL(origin).hostname)) return 'cloud';
	try {
		const res = await fetch(new URL('/_edge/tenant_info', origin), {
			headers: { 'Accept': 'application/json' },
		});
		if (res.ok && (await res.json()).cloudId) return 'cloud';
	} catch {
		// An unreachable or non-JSON probe means no Atlassian edge; the real request reports connection errors.
	}
	return 'server';
}

async function connect() {
	const base = new URL(get('confluence.baseUrl'));
	if (!deployments.has(base.origin)) deployments.set(base.origin, detectDeployment(base.origin));
	const kind = await deployments.get(base.origin);
	// Cloud always serves Confluence under /wiki; Server/Data Center keeps its own context path.
	const path = kind === 'cloud' ? '/wiki' : base.pathname.replace(/\/+$/, '');
	return { kind, origin: base.origin, path };
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
function authHeader(conn) {
	const email = get('confluence.email');
	const token = get('confluence.token');
	if (conn.kind === 'server' && !email) return `Bearer ${token}`;
	return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function request(conn, url, params = {}) {
	if (url.origin !== conn.origin) {
		throw new Error('Confluence pagination points to a different site. Check confluence.baseUrl.');
	}
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null) url.searchParams.set(k, v);
	}

	const res = await fetch(url, {
		headers: {
			'Authorization': authHeader(conn),
			'Accept': 'application/json',
		},
	});

	if (!res.ok) {
		const err = new Error(`Confluence API error: ${res.status} ${res.statusText}`);
		err.status = res.status;
		err.url = url.toString();
		throw err;
	}

	// Server/Data Center answers rejected credentials with a login page instead of a 401.
	if (!res.headers.get('content-type')?.includes('json')) {
		const err = new Error('Confluence returned a non-JSON response. Check confluence.baseUrl and confluence.token.');
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
		createdAt: page.history?.createdDate,
		version: page.version ? { number: page.version.number } : undefined,
		body: page.body,
	};
}

// The content listing silently returns nothing for an unknown space key, so the space is looked up first.
async function serverSpaceKey(conn, { spaceId, spaceKey }) {
	if (!spaceKey) return (await listSpaces()).find((s) => s.id === String(spaceId))?.key;
	try {
		return (await request(conn, apiUrl(conn, `/rest/api/space/${encodeURIComponent(spaceKey)}`))).key;
	} catch (err) {
		if (err.status === 404) return undefined;
		throw err;
	}
}

export async function listSpaces() {
	const conn = await connect();
	if (conn.kind === 'cloud') return paginate(conn, '/api/v2/spaces');
	return (await paginate(conn, '/rest/api/space', { limit: 100 })).map(serverSpace);
}

export async function getPage(id) {
	const conn = await connect();
	if (conn.kind === 'cloud') {
		return request(conn, apiUrl(conn, `/api/v2/pages/${id}`), { 'body-format': 'storage' });
	}
	return serverPage(await request(conn, apiUrl(conn, `/rest/api/content/${id}`), {
		expand: 'body.storage,version,space,history',
	}));
}

// Cloud lists pages by space ID and Server/Data Center by space key; returns null for an unknown space.
export async function listSpacePages({ spaceId, spaceKey }) {
	const conn = await connect();
	if (conn.kind === 'cloud') {
		const id = spaceId
			?? (await request(conn, apiUrl(conn, '/api/v2/spaces'), { keys: spaceKey })).results?.[0]?.id;
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

export async function searchPages(cql) {
	const conn = await connect();
	const result = await request(conn, apiUrl(conn, '/rest/api/search'), { cql });
	return { ...result, totalSize: result.totalSize ?? result.totalCount };
}
