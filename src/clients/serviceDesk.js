import { get } from '../config/store.js';

function baseUrl() {
	return get('serviceDesk.baseUrl');
}

function authHeader() {
	const email = get('serviceDesk.email');
	const token = get('serviceDesk.token');
	return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function request(path, params = {}, extraHeaders = {}) {
	const url = new URL(path.startsWith('http') ? path : `${baseUrl()}${path}`);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
	}

	const res = await fetch(url, {
		headers: {
			'Authorization': authHeader(),
			'Accept': 'application/json',
			...extraHeaders,
		},
	});

	if (!res.ok) {
		const err = new Error(`Service Desk API error: ${res.status} ${res.statusText}`);
		err.status = res.status;
		err.url = url.toString();
		throw err;
	}

	return res.json();
}

export async function getIssue(issueKey) {
	return request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
		expand: 'renderedFields',
	});
}

export async function getIssueComments(issueKey) {
	const data = await request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
		orderBy: 'created',
		maxResults: 100,
	});
	return data.comments || [];
}

export async function searchIssues(jql, maxResults = 50, nextPageToken = '') {
	const fields = 'summary,status,assignee,priority,updated,issuetype,reporter,customfield_10010';
	const data = await request('/rest/api/3/search/jql', {
		jql,
		fields,
		maxResults,
		nextPageToken,
	});
	return {
		issues: data.issues || [],
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
	const data = await request('/rest/servicedeskapi/servicedesk', { start: 0, limit: 100 }, { 'X-ExperimentalApi': 'opt-in' });
	const match = (data.values || []).find((sd) => sd.projectKey === projectKey);
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
	const data = await request(`/rest/servicedeskapi/servicedesk/${sdId}/queue`, { start: 0, limit: 100 }, { 'X-ExperimentalApi': 'opt-in' });
	return (data.values || []).map((q) => ({ id: q.id, name: q.name, jql: q.jql }));
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
