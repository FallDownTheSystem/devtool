import { get } from '../config/store.js';

function apiUrl(path) {
	return new URL(`/wiki${path}`, get('confluence.baseUrl'));
}

function authHeader() {
	const email = get('confluence.email');
	const token = get('confluence.token');
	return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function request(url, params = {}) {
	if (url.origin !== new URL(get('confluence.baseUrl')).origin) {
		throw new Error('Confluence pagination points to a different site. Check confluence.baseUrl.');
	}
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null) url.searchParams.set(k, v);
	}

	const res = await fetch(url, {
		headers: {
			'Authorization': authHeader(),
			'Accept': 'application/json',
		},
	});

	if (!res.ok) {
		const err = new Error(`Confluence API error: ${res.status} ${res.statusText}`);
		err.status = res.status;
		err.url = url.toString();
		throw err;
	}

	return res.json();
}

async function paginateV2(path, params = {}) {
	const results = [];
	let url = apiUrl(path);
	let data = await request(url, params);
	results.push(...(data.results || []));

	while (data._links?.next) {
		url = new URL(data._links.next, url);
		data = await request(url);
		results.push(...(data.results || []));
	}

	return results;
}

export async function listSpaces() {
	return paginateV2('/api/v2/spaces');
}

export async function getPage(id) {
	return request(apiUrl(`/api/v2/pages/${id}`), { 'body-format': 'storage' });
}

export async function listSpacePages(spaceId) {
	return paginateV2(`/api/v2/spaces/${spaceId}/pages`);
}

export async function searchPages(cql) {
	return request(apiUrl('/rest/api/search'), { cql });
}
