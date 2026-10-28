import { jsonInit, apiError } from '../utils/http.js';
import { collectPages, pickIssueType } from '../utils/jiraFields.js';

// Jira Server/Data Center through REST v2: wiki-markup strings and user names.

// A personal access token uses Bearer auth; a username (the email field) switches to Basic.
function authHeader({ email = '', token = '' }) {
	return email ? 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64') : `Bearer ${token}`;
}

function url(connection, path, params = {}) {
	const result = new URL(`${connection.baseUrl.replace(/\/+$/, '')}${path}`);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null && v !== '') result.searchParams.set(k, Array.isArray(v) ? v.join(',') : v);
	}
	return result;
}

async function request(connection, path, params, { method, body } = {}) {
	const target = url(connection, path, params);
	const res = await fetch(target, jsonInit({ method, body, headers: { 'Authorization': authHeader(connection) } }));
	// Jira answers rejected credentials on some endpoints as an anonymous user with status 200 and says so
	// in this header; treating that as data would hide a revoked token behind empty results.
	if (/^AUTHENTICAT(ED_FAILED|ION_DENIED)$/.test(res.headers.get('x-seraph-loginreason') || '')) {
		const err = new Error('Jira API error: 401 the credentials were rejected');
		err.status = 401;
		err.url = target.toString();
		throw err;
	}
	if (!res.ok) throw await apiError('Jira', res, target);
	const text = await res.text();
	return text ? JSON.parse(text) : null;
}

const get = (connection, path, params) => request(connection, path, params);

function issuePath(issueKey, suffix = '') {
	return `/rest/api/2/issue/${encodeURIComponent(issueKey)}${suffix}`;
}

export async function getIssue(connection, issueKey) {
	return get(connection, issuePath(issueKey), { fields: '*all', expand: 'renderedFields,names' });
}

export async function getIssueComments(connection, issueKey) {
	const result = await get(connection, issuePath(issueKey, '/comment'), { orderBy: 'created', maxResults: 100 });
	return result.comments || [];
}

export async function searchIssues(connection, jql, startAt = 0, maxResults = 50) {
	const result = await get(connection, '/rest/api/2/search', {
		jql,
		startAt,
		maxResults,
		fields: 'key,summary,status,assignee,priority,updated',
	});
	return {
		issues: result.issues || [],
		total: result.total || 0,
		startAt: result.startAt || 0,
		maxResults: result.maxResults || maxResults,
	};
}

export async function getMyIssues(connection) {
	const project = connection.defaultProject;
	const jql = project
		? `project = ${project} AND assignee = currentUser() AND status != Done ORDER BY updated DESC`
		: `assignee = currentUser() AND status != Done ORDER BY updated DESC`;
	return searchIssues(connection, jql);
}

export async function getTransitions(connection, issueKey) {
	const result = await get(connection, issuePath(issueKey, '/transitions'));
	return result.transitions || [];
}

export async function createIssue(connection, fields) {
	return request(connection, '/rest/api/2/issue', {}, { method: 'POST', body: { fields } });
}

export async function editIssue(connection, issueKey, fields) {
	await request(connection, issuePath(issueKey), {}, { method: 'PUT', body: { fields } });
}

export async function deleteIssue(connection, issueKey, deleteSubtasks = false) {
	await request(connection, issuePath(issueKey), { deleteSubtasks: deleteSubtasks ? 'true' : undefined }, { method: 'DELETE' });
}

export async function transitionIssue(connection, issueKey, transitionId) {
	await request(connection, issuePath(issueKey, '/transitions'), {}, { method: 'POST', body: { transition: { id: transitionId } } });
}

export async function getComment(connection, issueKey, id) {
	return get(connection, issuePath(issueKey, `/comment/${encodeURIComponent(id)}`));
}

export async function addComment(connection, issueKey, body) {
	return request(connection, issuePath(issueKey, '/comment'), {}, { method: 'POST', body: { body } });
}

export async function updateComment(connection, issueKey, id, body) {
	return request(connection, issuePath(issueKey, `/comment/${encodeURIComponent(id)}`), {}, { method: 'PUT', body: { body } });
}

export async function deleteComment(connection, issueKey, id) {
	await request(connection, issuePath(issueKey, `/comment/${encodeURIComponent(id)}`), {}, { method: 'DELETE' });
}

// The base URL and authentication that `dev api` sends raw read requests with.
export function apiTarget(connection) {
	return { base: new URL(connection.baseUrl), headers: { 'Authorization': authHeader(connection) } };
}

// --- Worklogs ---

export async function getWorklogs(connection, issueKey) {
	return collectPages((startAt) => get(connection, issuePath(issueKey, '/worklog'), { startAt, maxResults: 100 }), (data) => data.worklogs);
}

export async function getWorklog(connection, issueKey, id) {
	return get(connection, issuePath(issueKey, `/worklog/${encodeURIComponent(id)}`));
}

// `estimate` is { adjustEstimate, newEstimate, reduceBy } as the API takes them as query parameters.
export async function addWorklog(connection, issueKey, { timeSpent, started, comment }, estimate = {}) {
	return request(connection, issuePath(issueKey, '/worklog'), estimate, {
		method: 'POST',
		body: { timeSpent, started, ...(comment && { comment }) },
	});
}

export async function deleteWorklog(connection, issueKey, id, estimate = {}) {
	await request(connection, issuePath(issueKey, `/worklog/${encodeURIComponent(id)}`), estimate, { method: 'DELETE' });
}

export async function listQueues() {
	throw new Error('Queues are read through the Jira Cloud Service Desk API; this connection is Jira Server/Data Center. Use `dev api` with /rest/servicedeskapi/... instead.');
}

export const searchByQueue = listQueues;

export async function getFields(connection) {
	return get(connection, '/rest/api/2/field');
}

export async function getEditMeta(connection, issueKey) {
	return (await get(connection, `/rest/api/2/issue/${encodeURIComponent(issueKey)}/editmeta`)).fields || {};
}

const versions = new Map();

async function majorVersion(connection) {
	if (!versions.has(connection.baseUrl)) {
		versions.set(connection.baseUrl, get(connection, '/rest/api/2/serverInfo').then((info) => info.versionNumbers?.[0] ?? parseInt(info.version, 10)));
	}
	return versions.get(connection.baseUrl);
}

// Jira 9 removed the expand form of createmeta in favor of paged per-project, per-type endpoints;
// earlier versions have only the expand form. `issueType` is { id } or { name }.
export async function getCreateMeta(connection, project, issueType) {
	const base = `/rest/api/2/issue/createmeta/${encodeURIComponent(project)}/issuetypes`;
	if (await majorVersion(connection) >= 9) {
		const types = await collectPages((startAt) => get(connection, base, { startAt }), (data) => data.values);
		const type = pickIssueType(types, issueType, project);
		const fields = await collectPages((startAt) => get(connection, `${base}/${encodeURIComponent(type.id)}`, { startAt }), (data) => data.values);
		return { issueType: type, fields };
	}
	const data = await get(connection, '/rest/api/2/issue/createmeta', {
		[/^\d+$/.test(project) ? 'projectIds' : 'projectKeys']: project,
		expand: 'projects.issuetypes.fields',
	});
	const found = data.projects?.[0];
	if (!found) throw new Error(`Project ${project} was not found, or you cannot create issues in it.`);
	const type = pickIssueType(found.issuetypes || [], issueType, project);
	return { issueType: type, fields: type.fields || {} };
}

export async function getIssueChildren(connection, issueKey) {
	const issue = await getIssue(connection, issueKey);
	const type = issue.fields.issuetype?.name;
	const parent = { key: issue.key, type, summary: issue.fields.summary };

	if (type === 'Epic') {
		const data = await get(connection, `/rest/agile/1.0/epic/${encodeURIComponent(issueKey)}/issue`, {
			fields: 'summary,status,assignee,priority,updated,issuetype',
			maxResults: 100,
		});
		return {
			issues: data.issues || [],
			total: data.total ?? (data.issues || []).length,
			startAt: data.startAt || 0,
			maxResults: data.maxResults || 100,
			parent,
			source: 'epic',
		};
	}

	const subtasks = issue.fields.subtasks || [];
	return {
		issues: subtasks,
		total: subtasks.length,
		startAt: 0,
		maxResults: subtasks.length,
		parent,
		source: 'subtasks',
	};
}
