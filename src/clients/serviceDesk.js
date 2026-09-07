import { get } from '../config/store.js';

function configurationError(reason) {
	return new Error(`Service Desk configuration error: ${reason}. Check serviceDesk.baseUrl; use the canonical https://<site>.atlassian.net URL.`);
}

function baseUrl() {
	let url;
	try {
		url = new URL(get('serviceDesk.baseUrl'));
	} catch {
		throw configurationError('invalid base URL');
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[^/]/.test(url.pathname)) {
		throw configurationError('the base URL must be an HTTPS site URL without a path, query, or credentials');
	}
	return new URL(url.origin);
}

function authHeader() {
	const email = get('serviceDesk.email');
	const token = get('serviceDesk.token');
	return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function fetchJson(url, headers = {}) {
	const res = await fetch(url, {
		redirect: 'manual',
		headers: { 'Accept': 'application/json', ...headers },
	});

	if (res.redirected || (res.status >= 300 && res.status < 400)) {
		throw configurationError('the API returned a redirect; authentication may not reach the intended site');
	}
	if (res.url && new URL(res.url).origin !== url.origin) {
		throw configurationError('the API response came from an unexpected host');
	}
	if (!res.ok) {
		const err = new Error(`Service Desk API error: ${res.status} ${res.statusText}`);
		err.status = res.status;
		err.url = url.toString();
		throw err;
	}

	const contentType = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
	if (!/^application\/(?:[\w.+-]+\+)?json$/.test(contentType || '')) {
		throw configurationError('expected a JSON API response, but received a different content type');
	}
	let data;
	try {
		data = await res.json();
	} catch {
		throw configurationError('the API response contains invalid JSON');
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		throw configurationError('unexpected API response structure');
	}
	return data;
}

async function request(path, params = {}, { extraHeaders = {}, validate = () => true } = {}) {
	const site = baseUrl();
	if (!site.hostname.endsWith('.atlassian.net')) {
		const info = await fetchJson(new URL('/rest/api/2/serverInfo', site));
		let canonical;
		try {
			canonical = new URL(info.baseUrl);
		} catch {
			throw configurationError('serverInfo did not return a valid canonical base URL');
		}
		if (canonical.origin !== site.origin || canonical.pathname.replace(/\/+$/, '') !== '') {
			throw configurationError(`serverInfo identifies a different canonical base URL: ${canonical.origin}${canonical.pathname.replace(/\/+$/, '')}`);
		}
	}

	const url = new URL(path, site);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
	}
	const data = await fetchJson(url, { 'Authorization': authHeader(), ...extraHeaders });
	if (!validate(data)) throw configurationError('unexpected API response structure');
	return data;
}

export async function getIssue(issueKey) {
	return request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
		expand: 'renderedFields',
	}, {
		validate: (data) => typeof data.key === 'string' && data.fields && typeof data.fields === 'object' && !Array.isArray(data.fields),
	});
}

export async function getIssueComments(issueKey) {
	const data = await request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
		orderBy: 'created',
		maxResults: 100,
	}, {
		validate: (data) => Array.isArray(data.comments),
	});
	return data.comments;
}

export async function searchIssues(jql, maxResults = 50, nextPageToken = '') {
	const fields = 'summary,status,assignee,priority,updated,issuetype,reporter,customfield_10010';
	const data = await request('/rest/api/3/search/jql', {
		jql,
		fields,
		maxResults,
		nextPageToken,
	}, {
		validate: (data) => Array.isArray(data.issues)
			&& (data.isLast === undefined || typeof data.isLast === 'boolean')
			&& (data.nextPageToken == null || typeof data.nextPageToken === 'string'),
	});
	return {
		issues: data.issues,
		nextPageToken: data.nextPageToken || null,
		isLast: data.isLast !== false,
		maxResults,
	};
}

export async function getMyIssues() {
	const project = get('serviceDesk.defaultProject');
	const jql = project
		? `project = ${project} AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`
		: `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`;
	return searchIssues(jql);
}

let _serviceDeskIdCache = null;

async function getServiceDeskId(projectKey) {
	if (_serviceDeskIdCache && _serviceDeskIdCache.projectKey === projectKey) {
		return _serviceDeskIdCache.id;
	}
	const data = await request('/rest/servicedeskapi/servicedesk', { start: 0, limit: 100 }, {
		extraHeaders: { 'X-ExperimentalApi': 'opt-in' },
		validate: (data) => Array.isArray(data.values),
	});
	const match = data.values.find((sd) => sd.projectKey === projectKey);
	if (!match) {
		throw new Error(`No Service Desk found for project ${projectKey}`);
	}
	_serviceDeskIdCache = { projectKey, id: match.id };
	return match.id;
}

export async function listQueues() {
	const projectKey = get('serviceDesk.defaultProject');
	if (!projectKey) throw new Error('serviceDesk.defaultProject is not configured');
	const sdId = await getServiceDeskId(projectKey);
	const data = await request(`/rest/servicedeskapi/servicedesk/${sdId}/queue`, { start: 0, limit: 100 }, {
		extraHeaders: { 'X-ExperimentalApi': 'opt-in' },
		validate: (data) => Array.isArray(data.values),
	});
	return data.values.map((q) => ({ id: q.id, name: q.name, jql: q.jql }));
}

export async function findQueue(nameOrId) {
	const queues = await listQueues();
	const idMatch = queues.find((q) => String(q.id) === String(nameOrId));
	if (idMatch) return idMatch;
	const lower = nameOrId.toLowerCase();
	const exact = queues.find((q) => q.name.toLowerCase() === lower);
	if (exact) return exact;
	const partial = queues.filter((q) => q.name.toLowerCase().includes(lower));
	if (partial.length === 1) return partial[0];
	if (partial.length > 1) {
		const err = new Error(`Ambiguous queue "${nameOrId}" — matches: ${partial.map((q) => q.name).join(', ')}`);
		err.candidates = partial;
		throw err;
	}
	throw new Error(`No queue found matching "${nameOrId}"`);
}

export async function searchByQueue(nameOrId, maxResults = 50, nextPageToken = '') {
	const queue = await findQueue(nameOrId);
	const result = await searchIssues(queue.jql, maxResults, nextPageToken);
	return { ...result, queue };
}
