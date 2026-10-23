import { Version2Client } from 'jira.js';

const clients = new Map();

function getClient({ baseUrl, token }) {
	const key = `${baseUrl}\n${token}`;
	if (!clients.has(key)) {
		const client = new Version2Client({
			host: baseUrl,
			authentication: {
				basic: { email: '', apiToken: token },
			},
		});
		client.instance.interceptors.request.use((config) => {
			config.headers['Authorization'] = `Bearer ${token}`;
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
		expand: 'renderedFields',
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
