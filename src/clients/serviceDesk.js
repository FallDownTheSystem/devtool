import { jsonInit, apiError } from '../utils/http.js';
import { collectPages, pickIssueType } from '../utils/jiraFields.js';

function configurationError(reason) {
	return new Error(`Service Desk configuration error: ${reason}. Check the base URL of the Service Desk connection; use the canonical https://<site>.atlassian.net URL.`);
}

function baseUrl(connection) {
	let url;
	try {
		url = new URL(connection.baseUrl);
	} catch {
		throw configurationError('invalid base URL');
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[^/]/.test(url.pathname)) {
		throw configurationError('the base URL must be an HTTPS site URL without a path, query, or credentials');
	}
	return new URL(url.origin);
}

function authHeader({ email = '', token = '' }) {
	return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

// Only a write that documents an empty response may receive one; any other empty answer is a misconfiguration.
async function fetchJson(url, headers = {}, { method, body, allowEmpty = false, allowArray = false } = {}) {
	const res = await fetch(url, { ...jsonInit({ method, body, headers }), redirect: 'manual' });

	if (res.redirected || (res.status >= 300 && res.status < 400)) {
		throw configurationError('the API returned a redirect; authentication may not reach the intended site');
	}
	if (res.url && new URL(res.url).origin !== url.origin) {
		throw configurationError('the API response came from an unexpected host');
	}
	if (!res.ok) throw await apiError('Service Desk', res, url);
	if (allowEmpty && res.status === 204) return null;

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
	if (!data || typeof data !== 'object' || (Array.isArray(data) && !allowArray)) {
		throw configurationError('unexpected API response structure');
	}
	return data;
}

// A site that is not *.atlassian.net must name itself as its canonical base URL, so credentials are
// sent only to the site the connection points to.
async function verifiedSite(connection) {
	const site = baseUrl(connection);
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
	return site;
}

// The base URL and authentication that `dev api` sends raw read requests with.
export async function apiTarget(connection) {
	return { base: await verifiedSite(connection), headers: { 'Authorization': authHeader(connection) } };
}

async function request(connection, path, params = {}, { extraHeaders = {}, validate = () => true, method, body, allowEmpty, allowArray } = {}) {
	const site = await verifiedSite(connection);
	const url = new URL(path, site);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
	}
	const data = await fetchJson(url, { 'Authorization': authHeader(connection), ...extraHeaders }, { method, body, allowEmpty, allowArray });
	if (data !== null && !validate(data)) throw configurationError('unexpected API response structure');
	return data;
}

function issuePath(issueKey, suffix = '') {
	return `/rest/api/3/issue/${encodeURIComponent(issueKey)}${suffix}`;
}

export async function getIssue(connection, issueKey) {
	return request(connection, issuePath(issueKey), {
		expand: 'renderedFields,names',
	}, {
		validate: (data) => typeof data.key === 'string' && data.fields && typeof data.fields === 'object' && !Array.isArray(data.fields),
	});
}

export async function getIssueComments(connection, issueKey) {
	const data = await request(connection, issuePath(issueKey, '/comment'), {
		orderBy: 'created',
		maxResults: 100,
	}, {
		validate: (data) => Array.isArray(data.comments),
	});
	return data.comments;
}

export async function searchIssues(connection, jql, maxResults = 50, nextPageToken = '') {
	const fields = 'summary,status,assignee,priority,updated,issuetype,reporter,customfield_10010';
	const data = await request(connection, '/rest/api/3/search/jql', {
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

export async function getMyIssues(connection) {
	const project = connection.defaultProject;
	const jql = project
		? `project = ${project} AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`
		: `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`;
	return searchIssues(connection, jql);
}

// Keyed by site as well as project, because two sites can both have a project with the same key.
const serviceDeskIds = new Map();

async function getServiceDeskId(connection, projectKey) {
	const key = `${baseUrl(connection).origin} ${projectKey}`;
	if (serviceDeskIds.has(key)) return serviceDeskIds.get(key);
	const data = await request(connection, '/rest/servicedeskapi/servicedesk', { start: 0, limit: 100 }, {
		extraHeaders: { 'X-ExperimentalApi': 'opt-in' },
		validate: (data) => Array.isArray(data.values),
	});
	const match = data.values.find((sd) => sd.projectKey === projectKey);
	if (!match) {
		throw new Error(`No Service Desk found for project ${projectKey}`);
	}
	serviceDeskIds.set(key, match.id);
	return match.id;
}

export async function listQueues(connection) {
	const projectKey = connection.defaultProject;
	if (!projectKey) throw new Error('No default project is set on the Service Desk connection');
	const sdId = await getServiceDeskId(connection, projectKey);
	const data = await request(connection, `/rest/servicedeskapi/servicedesk/${sdId}/queue`, { start: 0, limit: 100 }, {
		extraHeaders: { 'X-ExperimentalApi': 'opt-in' },
		validate: (data) => Array.isArray(data.values),
	});
	return data.values.map((q) => ({ id: q.id, name: q.name, jql: q.jql }));
}

export async function findQueue(connection, nameOrId) {
	const queues = await listQueues(connection);
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

export async function searchByQueue(connection, nameOrId, maxResults = 50, nextPageToken = '') {
	const queue = await findQueue(connection, nameOrId);
	const result = await searchIssues(connection, queue.jql, maxResults, nextPageToken);
	return { ...result, queue };
}

export async function getTransitions(connection, issueKey) {
	const data = await request(connection, issuePath(issueKey, '/transitions'), {}, {
		validate: (data) => Array.isArray(data.transitions),
	});
	return data.transitions;
}

// `fields` is a Jira REST v3 fields object; rich-text fields must already be ADF.
export async function createIssue(connection, fields) {
	return request(connection, '/rest/api/3/issue', {}, {
		method: 'POST',
		body: { fields },
		validate: (data) => typeof data.key === 'string',
	});
}

export async function editIssue(connection, issueKey, fields) {
	await request(connection, issuePath(issueKey), {}, { method: 'PUT', body: { fields }, allowEmpty: true });
}

export async function deleteIssue(connection, issueKey, deleteSubtasks = false) {
	await request(connection, issuePath(issueKey), { deleteSubtasks: deleteSubtasks ? 'true' : undefined }, {
		method: 'DELETE',
		allowEmpty: true,
	});
}

export async function transitionIssue(connection, issueKey, transitionId) {
	await request(connection, issuePath(issueKey, '/transitions'), {}, {
		method: 'POST',
		body: { transition: { id: transitionId } },
		allowEmpty: true,
	});
}

// The Service Desk endpoint distinguishes a customer-visible reply from an internal note.
export async function addComment(connection, issueKey, body, { isPublic = false } = {}) {
	return request(connection, `/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}/comment`, {}, {
		method: 'POST',
		body: { body, public: isPublic },
		validate: (data) => data.id !== undefined,
	});
}

export async function getComment(connection, issueKey, id) {
	return request(connection, issuePath(issueKey, `/comment/${encodeURIComponent(id)}`), {}, {
		validate: (data) => data.id !== undefined,
	});
}

// `body` is ADF, like every rich-text value this client sends.
export async function updateComment(connection, issueKey, id, body) {
	return request(connection, issuePath(issueKey, `/comment/${encodeURIComponent(id)}`), {}, {
		method: 'PUT',
		body: { body },
		validate: (data) => data.id !== undefined,
	});
}

export async function deleteComment(connection, issueKey, id) {
	await request(connection, issuePath(issueKey, `/comment/${encodeURIComponent(id)}`), {}, {
		method: 'DELETE',
		allowEmpty: true,
	});
}

export async function getFields(connection) {
	return request(connection, '/rest/api/3/field', {}, { allowArray: true, validate: Array.isArray });
}

export async function getEditMeta(connection, issueKey) {
	return (await request(connection, issuePath(issueKey, '/editmeta'))).fields || {};
}

// Jira Cloud has only the paged per-project, per-type createmeta endpoints. `issueType` is { id } or { name }.
export async function getCreateMeta(connection, project, issueType) {
	const base = `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`;
	const types = await collectPages((startAt) => request(connection, base, { startAt }), (data) => data.issueTypes);
	const type = pickIssueType(types, issueType, project);
	const fields = await collectPages((startAt) => request(connection, `${base}/${encodeURIComponent(type.id)}`, { startAt }), (data) => data.fields);
	return { issueType: type, fields };
}
