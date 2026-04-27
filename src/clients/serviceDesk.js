import { get } from '../config/store.js';

function baseUrl() {
	return get('serviceDesk.baseUrl');
}

function authHeader() {
	const email = get('serviceDesk.email');
	const token = get('serviceDesk.token');
	return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function request(path, params = {}) {
	const url = new URL(path.startsWith('http') ? path : `${baseUrl()}${path}`);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
	}

	const res = await fetch(url, {
		headers: {
			'Authorization': authHeader(),
			'Accept': 'application/json',
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
