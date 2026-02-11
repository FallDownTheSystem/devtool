import { Command } from 'commander';
import {
	listPullRequests,
	getPullRequest,
	getPullRequestComments,
	getPullRequestDiffstat,
	getPullRequestActivity,
} from '../clients/bitbucket.js';
import {
	formatPrList,
	formatPrView,
	formatPrComments,
	formatPrDiffstat,
	formatPrActivity,
} from '../formatters/pr.js';
import { spinner } from '../utils/output.js';
import { handleError } from '../utils/errors.js';

const pr = new Command('pr')
	.description('Bitbucket pull requests');

pr.command('list')
	.description('List pull requests')
	.option('-s, --state <state>', 'PR state (OPEN, MERGED, DECLINED)', 'OPEN')
	.option('-a, --author <name>', 'Filter by author')
	.option('-r, --repo <slug>', 'Repository slug (overrides default)')
	.action(async (opts) => {
		const s = spinner('Fetching pull requests...').start();
		try {
			const prs = await listPullRequests({
				state: opts.state,
				author: opts.author,
				repo: opts.repo,
			});
			s.success({ text: `${prs.length} pull request(s) found` });
			formatPrList(prs);
		} catch (err) {
			s.error({ text: 'Failed to fetch pull requests' });
			handleError(err, err.url || 'bitbucket');
		}
	});

pr.command('view <id>')
	.description('View pull request details')
	.option('-r, --repo <slug>', 'Repository slug (overrides default)')
	.action(async (id, opts) => {
		const s = spinner(`Fetching PR #${id}...`).start();
		try {
			const data = await getPullRequest(id, opts.repo);
			s.success({ text: `PR #${id}` });
			formatPrView(data);
		} catch (err) {
			s.error({ text: `Failed to fetch PR #${id}` });
			handleError(err, err.url || 'bitbucket');
		}
	});

pr.command('comments <id>')
	.description('List pull request comments')
	.option('-r, --repo <slug>', 'Repository slug (overrides default)')
	.action(async (id, opts) => {
		const s = spinner(`Fetching comments for PR #${id}...`).start();
		try {
			const comments = await getPullRequestComments(id, opts.repo);
			s.success({ text: `${comments.length} comment(s)` });
			formatPrComments(comments);
		} catch (err) {
			s.error({ text: `Failed to fetch comments for PR #${id}` });
			handleError(err, err.url || 'bitbucket');
		}
	});

pr.command('diff <id>')
	.description('Show pull request diffstat')
	.option('-r, --repo <slug>', 'Repository slug (overrides default)')
	.action(async (id, opts) => {
		const s = spinner(`Fetching diffstat for PR #${id}...`).start();
		try {
			const files = await getPullRequestDiffstat(id, opts.repo);
			s.success({ text: `${files.length} file(s) changed` });
			formatPrDiffstat(files);
		} catch (err) {
			s.error({ text: `Failed to fetch diffstat for PR #${id}` });
			handleError(err, err.url || 'bitbucket');
		}
	});

pr.command('activity <id>')
	.description('Show pull request activity')
	.option('-r, --repo <slug>', 'Repository slug (overrides default)')
	.action(async (id, opts) => {
		const s = spinner(`Fetching activity for PR #${id}...`).start();
		try {
			const activities = await getPullRequestActivity(id, opts.repo);
			s.success({ text: `${activities.length} activity item(s)` });
			formatPrActivity(activities);
		} catch (err) {
			s.error({ text: `Failed to fetch activity for PR #${id}` });
			handleError(err, err.url || 'bitbucket');
		}
	});

export default pr;
