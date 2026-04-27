import { Command } from 'commander';
import {
	getIssue,
	getIssueComments,
	searchIssues,
	getMyIssues,
	listQueues,
	searchByQueue,
} from '../clients/serviceDesk.js';
import {
	formatIssueView, formatIssueComments, formatIssueSearch,
	plainIssueView, plainIssueComments, plainIssueSearch,
	curateIssueJson, curateCommentsJson, curateSearchJson,
	formatQueueList, plainQueueList, curateQueuesJson,
} from '../formatters/serviceDesk.js';
import { spinner } from '../utils/output.js';
import { handleError } from '../utils/errors.js';
import { getOutputMode, outputJson } from '../utils/mode.js';

const sd = new Command('sd')
	.alias('servicedesk')
	.description('Jira Service Desk Cloud tickets');

sd.command('view <key>')
	.alias('read')
	.description('View ticket details')
	.action(async function (key) {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner(`Fetching ${key}...`).start() : null;
		try {
			const issue = await getIssue(key);
			if (s) s.success({ text: key });
			if (mode === 'json') outputJson(curateIssueJson(issue));
			else if (mode === 'plain') plainIssueView(issue);
			else formatIssueView(issue);
		} catch (err) {
			if (s) s.error({ text: `Failed to fetch ${key}` });
			handleError(err, `sd view ${key}`);
		}
	});

sd.command('comments <key>')
	.description('List ticket comments')
	.action(async function (key) {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner(`Fetching comments for ${key}...`).start() : null;
		try {
			const comments = await getIssueComments(key);
			if (s) s.success({ text: `${comments.length} comment(s)` });
			if (mode === 'json') outputJson(curateCommentsJson(comments));
			else if (mode === 'plain') plainIssueComments(comments);
			else formatIssueComments(comments);
		} catch (err) {
			if (s) s.error({ text: `Failed to fetch comments for ${key}` });
			handleError(err, `sd comments ${key}`);
		}
	});

sd.command('search <jql>')
	.alias('find')
	.description('Search Service Desk tickets with JQL')
	.option('-n, --per-page <number>', 'Results per page', '20')
	.option('--next <token>', 'Continuation token from a previous page')
	.action(async function (jql, opts) {
		const mode = getOutputMode(this);
		const perPage = parseInt(opts.perPage, 10);
		const s = mode === 'rich' ? spinner('Searching...').start() : null;
		try {
			const result = await searchIssues(jql, perPage, opts.next || '');
			if (s) s.success({ text: `${result.issues.length} issue(s) returned` });
			if (mode === 'json') outputJson(curateSearchJson(result));
			else if (mode === 'plain') plainIssueSearch(result);
			else formatIssueSearch(result);
		} catch (err) {
			if (s) s.error({ text: 'Search failed' });
			handleError(err, `sd search "${jql}"`);
		}
	});

sd.command('queues')
	.description('List Service Desk queues for the default project')
	.action(async function () {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner('Fetching queues...').start() : null;
		try {
			const queues = await listQueues();
			if (s) s.success({ text: `${queues.length} queue(s)` });
			if (mode === 'json') outputJson(curateQueuesJson(queues));
			else if (mode === 'plain') plainQueueList(queues);
			else formatQueueList(queues);
		} catch (err) {
			if (s) s.error({ text: 'Failed to fetch queues' });
			handleError(err, 'sd queues');
		}
	});

sd.command('queue <nameOrId>')
	.description('Show issues in a Service Desk queue (by name or id)')
	.option('-n, --per-page <number>', 'Results per page', '20')
	.option('--next <token>', 'Continuation token from a previous page')
	.action(async function (nameOrId, opts) {
		const mode = getOutputMode(this);
		const perPage = parseInt(opts.perPage, 10);
		const s = mode === 'rich' ? spinner(`Fetching queue "${nameOrId}"...`).start() : null;
		try {
			const result = await searchByQueue(nameOrId, perPage, opts.next || '');
			if (s) s.success({ text: `${result.issues.length} issue(s) in "${result.queue.name}"` });
			if (mode === 'json') outputJson(curateSearchJson(result));
			else if (mode === 'plain') plainIssueSearch(result);
			else formatIssueSearch(result);
		} catch (err) {
			if (s) s.error({ text: `Failed to fetch queue "${nameOrId}"` });
			handleError(err, `sd queue ${nameOrId}`);
		}
	});

sd.command('mine')
	.alias('my')
	.description('Show my open Service Desk tickets')
	.action(async function () {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner('Fetching my tickets...').start() : null;
		try {
			const result = await getMyIssues();
			if (s) s.success({ text: `${result.issues.length} ticket(s)` });
			if (mode === 'json') outputJson(curateSearchJson(result));
			else if (mode === 'plain') plainIssueSearch(result);
			else formatIssueSearch(result);
		} catch (err) {
			if (s) s.error({ text: 'Failed to fetch tickets' });
			handleError(err, 'sd my tickets');
		}
	});

export default sd;
