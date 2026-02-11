import { Command } from 'commander';
import {
	listPullRequests,
	getPullRequest,
	getPullRequestComments,
	getPullRequestDiffstat,
	getPullRequestActivity,
} from '../clients/bitbucket.js';
import {
	formatPrList, formatPrView, formatPrComments, formatPrDiffstat, formatPrActivity,
	plainPrList, plainPrView, plainPrComments, plainPrDiffstat, plainPrActivity,
	curateListJson, curateViewJson, curateCommentsJson, curateDiffstatJson, curateActivityJson,
} from '../formatters/pr.js';
import { spinner } from '../utils/output.js';
import { handleError } from '../utils/errors.js';
import { getOutputMode, outputJson } from '../utils/mode.js';

function withMode(cmd, fetchFn, { json, plain, rich }) {
	return async (...args) => {
		const mode = getOutputMode(cmd);
		const s = mode === 'rich' ? spinner('Loading...').start() : null;
		try {
			const data = await fetchFn(...args);
			if (s) s.success({ text: '' });
			if (mode === 'json') outputJson(json(data));
			else if (mode === 'plain') plain(data);
			else rich(data);
		} catch (err) {
			if (s) s.error({ text: 'Failed' });
			handleError(err, err.url || 'bitbucket');
		}
	};
}

const pr = new Command('pr')
	.description('Bitbucket pull requests');

pr.command('list')
	.description('List pull requests')
	.option('-s, --state <state>', 'PR state (OPEN, MERGED, DECLINED)', 'OPEN')
	.option('-a, --author <name>', 'Filter by author')
	.option('-r, --repo <slug>', 'Repository slug (overrides default)')
	.action(async function (opts) {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner('Fetching pull requests...').start() : null;
		try {
			const prs = await listPullRequests({ state: opts.state, author: opts.author, repo: opts.repo });
			if (s) s.success({ text: `${prs.length} pull request(s) found` });
			if (mode === 'json') outputJson(curateListJson(prs));
			else if (mode === 'plain') plainPrList(prs);
			else formatPrList(prs);
		} catch (err) {
			if (s) s.error({ text: 'Failed to fetch pull requests' });
			handleError(err, err.url || 'bitbucket');
		}
	});

pr.command('view <id>')
	.description('View pull request details')
	.option('-r, --repo <slug>', 'Repository slug (overrides default)')
	.action(async function (id, opts) {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner(`Fetching PR #${id}...`).start() : null;
		try {
			const data = await getPullRequest(id, opts.repo);
			if (s) s.success({ text: `PR #${id}` });
			if (mode === 'json') outputJson(curateViewJson(data));
			else if (mode === 'plain') plainPrView(data);
			else formatPrView(data);
		} catch (err) {
			if (s) s.error({ text: `Failed to fetch PR #${id}` });
			handleError(err, err.url || 'bitbucket');
		}
	});

pr.command('comments <id>')
	.description('List pull request comments')
	.option('-r, --repo <slug>', 'Repository slug (overrides default)')
	.action(async function (id, opts) {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner(`Fetching comments for PR #${id}...`).start() : null;
		try {
			const comments = await getPullRequestComments(id, opts.repo);
			if (s) s.success({ text: `${comments.length} comment(s)` });
			if (mode === 'json') outputJson(curateCommentsJson(comments));
			else if (mode === 'plain') plainPrComments(comments);
			else formatPrComments(comments);
		} catch (err) {
			if (s) s.error({ text: `Failed to fetch comments for PR #${id}` });
			handleError(err, err.url || 'bitbucket');
		}
	});

pr.command('diff <id>')
	.description('Show pull request diffstat')
	.option('-r, --repo <slug>', 'Repository slug (overrides default)')
	.action(async function (id, opts) {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner(`Fetching diffstat for PR #${id}...`).start() : null;
		try {
			const files = await getPullRequestDiffstat(id, opts.repo);
			if (s) s.success({ text: `${files.length} file(s) changed` });
			if (mode === 'json') outputJson(curateDiffstatJson(files));
			else if (mode === 'plain') plainPrDiffstat(files);
			else formatPrDiffstat(files);
		} catch (err) {
			if (s) s.error({ text: `Failed to fetch diffstat for PR #${id}` });
			handleError(err, err.url || 'bitbucket');
		}
	});

pr.command('activity <id>')
	.description('Show pull request activity')
	.option('-r, --repo <slug>', 'Repository slug (overrides default)')
	.action(async function (id, opts) {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner(`Fetching activity for PR #${id}...`).start() : null;
		try {
			const activities = await getPullRequestActivity(id, opts.repo);
			if (s) s.success({ text: `${activities.length} activity item(s)` });
			if (mode === 'json') outputJson(curateActivityJson(activities));
			else if (mode === 'plain') plainPrActivity(activities);
			else formatPrActivity(activities);
		} catch (err) {
			if (s) s.error({ text: `Failed to fetch activity for PR #${id}` });
			handleError(err, err.url || 'bitbucket');
		}
	});

export default pr;
