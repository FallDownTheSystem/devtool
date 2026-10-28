import { Command } from 'commander';
import { JIRA_TYPES, site } from '../clients/jira.js';
import { addIssueWriteCommands } from './issueWrites.js';
import { addIssueFieldsCommand, VIEW_FIELDS_HELP, VIEW_ALL_FIELDS_HELP } from './issueFields.js';
import { requestedFields } from '../utils/jiraFields.js';
import {
	formatIssueView, formatIssueComments, formatIssueSearch,
	plainIssueView, plainIssueComments, plainIssueSearch,
	curateIssueJson, curateCommentsJson, curateSearchJson,
	formatIssueChildren, plainIssueChildren, curateChildrenJson,
	formatQueueList, plainQueueList, curateQueuesJson,
} from '../formatters/jira.js';
import { spinner } from '../utils/output.js';
import { handleError } from '../utils/errors.js';
import { getOutputMode, outputJson } from '../utils/mode.js';
import { connectionFor } from '../utils/connection.js';

// Runs a read: resolves the connection (routed by `route`, an issue or project key), shows a spinner in
// rich mode, and prints the result in the output mode.
function read(cmd, { types, route, busy, done, failed, context, fetch, json, plain, rich }) {
	const mode = getOutputMode(cmd);
	const s = mode === 'rich' ? spinner(busy).start() : null;
	return (async () => {
		try {
			const connection = connectionFor(cmd, types, route);
			const result = await fetch(connection, await site(connection));
			if (s) s.success({ text: done(result) });
			if (mode === 'json') outputJson(json(result));
			else if (mode === 'plain') plain(result);
			else rich(result);
		} catch (err) {
			if (s) s.error({ text: failed });
			handleError(err, err.url || context);
		}
	})();
}

// Server pages a search by startAt and Cloud by a continuation token.
function search(s, connection, jql, opts) {
	const perPage = parseInt(opts.perPage, 10);
	if (s.cloud) {
		if (opts.page !== '1') throw new Error('Jira Cloud pages a search by token: pass --next <token> from the previous page instead of --page.');
		return s.client.searchIssues(connection, jql, perPage, opts.next || '');
	}
	if (opts.next) throw new Error('--next is for Jira Cloud; use --page on Jira Server/Data Center.');
	return s.client.searchIssues(connection, jql, (parseInt(opts.page, 10) - 1) * perPage, perPage);
}

function searchDone(result) {
	return result.total !== undefined ? `${result.total} issue(s) matched` : `${result.issues.length} issue(s) returned`;
}

const searchOutput = { json: curateSearchJson, plain: plainIssueSearch, rich: formatIssueSearch };

// `dev jira` serves Jira Server/Data Center and Jira Cloud (including Service Desk) through `jira` and
// `serviceDesk` connections. `types` orders them for the default connection: `dev sd` keeps preferring
// a serviceDesk connection, as it did before the commands were merged.
export function jiraCommand(name, types) {
	const jira = new Command(name)
		.description('Jira issues, on Jira Cloud (including Service Desk) or Server/Data Center');

	jira.command('view <key>')
		.alias('read')
		.description('View issue details')
		.option('--fields <list>', VIEW_FIELDS_HELP)
		.option('--all-fields', VIEW_ALL_FIELDS_HELP)
		.action(function (key, opts) {
			let extra;
			return read(this, {
				types, route: key, busy: `Fetching ${key}...`, done: () => key, failed: `Failed to fetch ${key}`, context: `${name} issue ${key}`,
				fetch: async (connection, s) => {
					const issue = await s.client.getIssue(connection, key);
					extra = requestedFields(issue, opts);
					return issue;
				},
				json: (issue) => curateIssueJson(issue, extra),
				plain: (issue) => plainIssueView(issue, extra),
				rich: (issue) => formatIssueView(issue, extra),
			});
		});

	jira.command('comments <key>')
		.description('List issue comments')
		.action(function (key) {
			return read(this, {
				types, route: key, busy: `Fetching comments for ${key}...`, done: (c) => `${c.length} comment(s)`, failed: `Failed to fetch comments for ${key}`, context: `${name} comments ${key}`,
				fetch: (connection, s) => s.client.getIssueComments(connection, key),
				json: curateCommentsJson, plain: plainIssueComments, rich: formatIssueComments,
			});
		});

	jira.command('search <jql>')
		.alias('find')
		.description('Search issues with JQL')
		.option('-p, --page <number>', 'Page number (Jira Server/Data Center)', '1')
		.option('-n, --per-page <number>', 'Results per page', '20')
		.option('--next <token>', 'Continuation token from the previous page (Jira Cloud)')
		.option('--project <key>', 'Pick the connection that lists this project')
		.action(function (jql, opts) {
			return read(this, {
				types, route: opts.project, busy: 'Searching...', done: searchDone, failed: 'Search failed', context: `${name} search "${jql}"`,
				fetch: (connection, s) => search(s, connection, jql, opts),
				...searchOutput,
			});
		});

	jira.command('children <key>')
		.alias('subs')
		.description('List epic children or issue subtasks')
		.action(function (key) {
			return read(this, {
				types, route: key, busy: `Fetching children of ${key}...`, failed: `Failed to fetch children of ${key}`, context: `${name} children ${key}`,
				done: (r) => `${r.total} ${r.source === 'epic' ? 'issue(s) in epic' : 'subtask(s)'}`,
				fetch: (connection, s) => s.client.getIssueChildren(connection, key),
				json: curateChildrenJson, plain: plainIssueChildren, rich: formatIssueChildren,
			});
		});

	jira.command('mine')
		.alias('my')
		.description('Show my open issues')
		.option('--project <key>', 'Pick the connection that lists this project')
		.action(function (opts) {
			return read(this, {
				types, route: opts.project, busy: 'Fetching my issues...', done: (r) => `${r.issues.length} issue(s)`, failed: 'Failed to fetch issues', context: `${name} my issues`,
				fetch: (connection, s) => s.client.getMyIssues(connection),
				...searchOutput,
			});
		});

	jira.command('queues')
		.description('List the queues of a Service Desk project (Jira Cloud)')
		.option('--project <key>', 'Service Desk project (default: the connection\'s default project)')
		.action(function (opts) {
			return read(this, {
				types, route: opts.project, busy: 'Fetching queues...', done: (q) => `${q.length} queue(s)`, failed: 'Failed to fetch queues', context: `${name} queues`,
				fetch: (connection, s) => s.client.listQueues(connection, opts.project || connection.defaultProject),
				json: curateQueuesJson, plain: plainQueueList, rich: formatQueueList,
			});
		});

	jira.command('queue <nameOrId>')
		.description('Show the issues in a Service Desk queue, by name or ID (Jira Cloud)')
		.option('--project <key>', 'Service Desk project (default: the connection\'s default project)')
		.option('-n, --per-page <number>', 'Results per page', '20')
		.option('--next <token>', 'Continuation token from a previous page')
		.action(function (nameOrId, opts) {
			return read(this, {
				types, route: opts.project, busy: `Fetching queue "${nameOrId}"...`, failed: `Failed to fetch queue "${nameOrId}"`, context: `${name} queue ${nameOrId}`,
				done: (r) => `${r.issues.length} issue(s) in "${r.queue.name}"`,
				fetch: (connection, s) => s.client.searchByQueue(connection, nameOrId, parseInt(opts.perPage, 10), opts.next || '', opts.project || connection.defaultProject),
				...searchOutput,
			});
		});

	addIssueWriteCommands(jira, { types });
	addIssueFieldsCommand(jira, { types });
	return jira;
}

export default jiraCommand('jira', JIRA_TYPES);

// The Service Desk command group before 0.9; the same commands, preferring a serviceDesk connection.
export const sd = jiraCommand('sd', ['serviceDesk', 'jira'])
	.alias('servicedesk')
	.description('The same commands as `dev jira`; without a project match it uses the default Service Desk connection');
