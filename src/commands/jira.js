import { Command } from 'commander';
import {
	getIssue,
	getIssueComments,
	searchIssues,
	getMyIssues,
	getIssueChildren,
} from '../clients/jira.js';
import {
	formatIssueView, formatIssueComments, formatIssueSearch,
	plainIssueView, plainIssueComments, plainIssueSearch,
	curateIssueJson, curateCommentsJson, curateSearchJson,
	formatIssueChildren, plainIssueChildren, curateChildrenJson,
} from '../formatters/jira.js';
import { spinner } from '../utils/output.js';
import { handleError } from '../utils/errors.js';
import { getOutputMode, outputJson } from '../utils/mode.js';

const jira = new Command('jira')
	.description('Jira tickets');

jira.command('view <key>')
	.alias('read')
	.description('View issue details')
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
			handleError(err, `jira issue ${key}`);
		}
	});

jira.command('comments <key>')
	.description('List issue comments')
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
			handleError(err, `jira comments ${key}`);
		}
	});

jira.command('search <jql>')
	.alias('find')
	.description('Search issues with JQL')
	.option('-p, --page <number>', 'Page number', '1')
	.option('-n, --per-page <number>', 'Results per page', '20')
	.action(async function (jql, opts) {
		const mode = getOutputMode(this);
		const perPage = parseInt(opts.perPage, 10);
		const startAt = (parseInt(opts.page, 10) - 1) * perPage;
		const s = mode === 'rich' ? spinner('Searching...').start() : null;
		try {
			const result = await searchIssues(jql, startAt, perPage);
			if (s) s.success({ text: `${result.total} issue(s) matched` });
			if (mode === 'json') outputJson(curateSearchJson(result));
			else if (mode === 'plain') plainIssueSearch(result);
			else formatIssueSearch(result);
		} catch (err) {
			if (s) s.error({ text: 'Search failed' });
			handleError(err, `jira search "${jql}"`);
		}
	});

jira.command('children <key>')
	.alias('subs')
	.description('List epic children or issue subtasks')
	.action(async function (key) {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner(`Fetching children of ${key}...`).start() : null;
		try {
			const result = await getIssueChildren(key);
			if (s) s.success({ text: `${result.total} ${result.source === 'epic' ? 'issue(s) in epic' : 'subtask(s)'}` });
			if (mode === 'json') outputJson(curateChildrenJson(result));
			else if (mode === 'plain') plainIssueChildren(result);
			else formatIssueChildren(result);
		} catch (err) {
			if (s) s.error({ text: `Failed to fetch children of ${key}` });
			handleError(err, `jira children ${key}`);
		}
	});

jira.command('mine')
	.alias('my')
	.description('Show my open issues')
	.action(async function () {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner('Fetching my issues...').start() : null;
		try {
			const result = await getMyIssues();
			if (s) s.success({ text: `${result.total} issue(s)` });
			if (mode === 'json') outputJson(curateSearchJson(result));
			else if (mode === 'plain') plainIssueSearch(result);
			else formatIssueSearch(result);
		} catch (err) {
			if (s) s.error({ text: 'Failed to fetch issues' });
			handleError(err, 'jira my issues');
		}
	});

export default jira;
