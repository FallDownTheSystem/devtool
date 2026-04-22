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

export async function getIssueChildren(issueKey) {
	const issue = await getIssue(issueKey);
	const type = issue.fields.issuetype?.name;
	const parent = { key: issue.key, type, summary: issue.fields.summary };

	if (type === 'Epic') {
		const response = await getClient().instance.get(
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
