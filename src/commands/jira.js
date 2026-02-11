import { Command } from 'commander';
import {
	getIssue,
	getIssueComments,
	searchIssues,
	getMyIssues,
} from '../clients/jira.js';
import {
	formatIssueView,
	formatIssueComments,
	formatIssueSearch,
} from '../formatters/jira.js';
import { spinner } from '../utils/output.js';
import { handleError } from '../utils/errors.js';

const jira = new Command('jira')
	.description('Jira tickets');

jira.command('view <key>')
	.description('View issue details')
	.action(async (key) => {
		const s = spinner(`Fetching ${key}...`).start();
		try {
			const issue = await getIssue(key);
			s.success({ text: key });
			formatIssueView(issue);
		} catch (err) {
			s.error({ text: `Failed to fetch ${key}` });
			handleError(err, `jira issue ${key}`);
		}
	});

jira.command('comments <key>')
	.description('List issue comments')
	.action(async (key) => {
		const s = spinner(`Fetching comments for ${key}...`).start();
		try {
			const comments = await getIssueComments(key);
			s.success({ text: `${comments.length} comment(s)` });
			formatIssueComments(comments);
		} catch (err) {
			s.error({ text: `Failed to fetch comments for ${key}` });
			handleError(err, `jira comments ${key}`);
		}
	});

jira.command('search <jql>')
	.description('Search issues with JQL')
	.option('-p, --page <number>', 'Page number', '1')
	.option('-n, --per-page <number>', 'Results per page', '20')
	.action(async (jql, opts) => {
		const perPage = parseInt(opts.perPage, 10);
		const startAt = (parseInt(opts.page, 10) - 1) * perPage;
		const s = spinner('Searching...').start();
		try {
			const result = await searchIssues(jql, startAt, perPage);
			s.success({ text: `${result.total} issue(s) matched` });
			formatIssueSearch(result);
		} catch (err) {
			s.error({ text: 'Search failed' });
			handleError(err, `jira search "${jql}"`);
		}
	});

jira.command('mine')
	.description('Show my open issues')
	.action(async () => {
		const s = spinner('Fetching my issues...').start();
		try {
			const result = await getMyIssues();
			s.success({ text: `${result.total} issue(s)` });
			formatIssueSearch(result);
		} catch (err) {
			s.error({ text: 'Failed to fetch issues' });
			handleError(err, 'jira my issues');
		}
	});

export default jira;
