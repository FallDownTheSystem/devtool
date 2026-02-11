import { Version2Client } from 'jira.js';
import { get } from '../config/store.js';

let client = null;

function getClient() {
	if (!client) {
		const token = get('jira.token');
		client = new Version2Client({
			host: get('jira.baseUrl'),
			authentication: {
				basic: { email: '', apiToken: token },
			},
		});
		client.instance.interceptors.request.use((config) => {
			config.headers['Authorization'] = `Bearer ${token}`;
			return config;
		});
	}
	return client;
}

export async function getIssue(issueKey) {
	return getClient().issues.getIssue({
		issueIdOrKey: issueKey,
		fields: ['*all'],
		expand: 'renderedFields',
	});
}

export async function getIssueComments(issueKey) {
	const result = await getClient().issueComments.getComments({
		issueIdOrKey: issueKey,
		orderBy: 'created',
		maxResults: 100,
	});
	return result.comments || [];
}

export async function searchIssues(jql, startAt = 0, maxResults = 50) {
	const result = await getClient().issueSearch.searchForIssuesUsingJql({
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

export async function getMyIssues() {
	const project = get('jira.defaultProject');
	const jql = project
		? `project = ${project} AND assignee = currentUser() AND status != Done ORDER BY updated DESC`
		: `assignee = currentUser() AND status != Done ORDER BY updated DESC`;
	return searchIssues(jql);
}
