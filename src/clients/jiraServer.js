import { Version2Client } from 'jira.js';
import { requestTimeout } from '../utils/http.js';
import { collectPages, pickIssueType } from '../utils/jiraFields.js';

const clients = new Map();

// Jira Server/Data Center through REST v2: wiki-markup strings and user names.

// A personal access token uses Bearer auth; a username (the email field) switches to Basic.
function authHeader({ email = '', token = '' }) {
	return email ? 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64') : `Bearer ${token}`;
}

function getClient(connection) {
	const { baseUrl, email = '', token } = connection;
	const key = `${baseUrl}\n${email}\n${token}`;
	if (!clients.has(key)) {
		const client = new Version2Client({
			host: baseUrl,
			authentication: {
				basic: { email, apiToken: token },
			},
			baseRequestConfig: { timeout: requestTimeout() },
		});
		client.instance.interceptors.request.use((config) => {
			config.headers['Authorization'] = authHeader(connection);
			return config;
		});
		clients.set(key, client);
	}
	return clients.get(key);
}

export async function getIssue(connection, issueKey) {
	return getClient(connection).issues.getIssue({
		issueIdOrKey: issueKey,
		fields: ['*all'],
		expand: 'renderedFields,names',
	});
}

export async function getIssueComments(connection, issueKey) {
	const result = await getClient(connection).issueComments.getComments({
		issueIdOrKey: issueKey,
		orderBy: 'created',
		maxResults: 100,
	});
	return result.comments || [];
}

export async function searchIssues(connection, jql, startAt = 0, maxResults = 50) {
	const result = await getClient(connection).issueSearch.searchForIssuesUsingJql({
		jql,
		startAt,
		maxResults,
		fields: ['key', 'summary', 'status', 'assignee', 'priority', 'updated'],
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
	const result = await getClient(connection).issues.getTransitions({ issueIdOrKey: encodeURIComponent(issueKey) });
	return result.transitions || [];
}

export async function createIssue(connection, fields) {
	return getClient(connection).issues.createIssue({ fields });
}

export async function editIssue(connection, issueKey, fields) {
	await getClient(connection).issues.editIssue({ issueIdOrKey: encodeURIComponent(issueKey), fields });
}

export async function deleteIssue(connection, issueKey, deleteSubtasks = false) {
	await getClient(connection).issues.deleteIssue({ issueIdOrKey: encodeURIComponent(issueKey), deleteSubtasks });
}

export async function transitionIssue(connection, issueKey, transitionId) {
	await getClient(connection).issues.doTransition({
		issueIdOrKey: encodeURIComponent(issueKey),
		transition: { id: transitionId },
	});
}

export async function getComment(connection, issueKey, id) {
	return getClient(connection).issueComments.getComment({ issueIdOrKey: encodeURIComponent(issueKey), id });
}

export async function addComment(connection, issueKey, body) {
	return getClient(connection).issueComments.addComment({ issueIdOrKey: encodeURIComponent(issueKey), comment: body });
}

export async function updateComment(connection, issueKey, id, body) {
	return getClient(connection).issueComments.updateComment({ issueIdOrKey: encodeURIComponent(issueKey), id, comment: body });
}

export async function deleteComment(connection, issueKey, id) {
	await getClient(connection).issueComments.deleteComment({ issueIdOrKey: encodeURIComponent(issueKey), id });
}

// The base URL and authentication that `dev api` sends raw read requests with.
export function apiTarget(connection) {
	return { base: new URL(connection.baseUrl), headers: { 'Authorization': authHeader(connection) } };
}

async function get(connection, path, params) {
	return (await getClient(connection).instance.get(path, { params })).data;
}

function issuePath(issueKey, suffix = '') {
	return `/rest/api/2/issue/${encodeURIComponent(issueKey)}${suffix}`;
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
	const response = await getClient(connection).instance.post(issuePath(issueKey, '/worklog'), {
		timeSpent, started, ...(comment && { comment }),
	}, { params: estimate });
	return response.data;
}

export async function deleteWorklog(connection, issueKey, id, estimate = {}) {
	await getClient(connection).instance.delete(issuePath(issueKey, `/worklog/${encodeURIComponent(id)}`), { params: estimate });
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
		const response = await getClient(connection).instance.get(
			`/rest/agile/1.0/epic/${encodeURIComponent(issueKey)}/issue`,
			{
				params: {
					fields: 'summary,status,assignee,priority,updated,issuetype',
					maxResults: 100,
				},
			}
		);
		const data = response.data;
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
