import { Command, InvalidArgumentError } from 'commander';
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
import { connectionFor } from '../utils/connection.js';
import { runWrite, readText, collect, FILE_HELP } from '../utils/write.js';
import * as actions from '../actions/bitbucket.js';

const pr = new Command('pr')
	.description('Bitbucket pull requests');

pr.command('list')
	.alias('ls')
	.description('List pull requests')
	.option('-s, --state <state>', 'PR state (OPEN, MERGED, DECLINED)', 'OPEN')
	.option('-a, --author <name>', 'Filter by author')
	.option('-r, --repo <slug>', 'Repository slug (overrides default)')
	.action(async function (opts) {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner('Fetching pull requests...').start() : null;
		try {
			const prs = await listPullRequests(connectionFor(this, 'bitbucket'), { state: opts.state, author: opts.author, repo: opts.repo });
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
	.alias('read')
	.description('View pull request details')
	.option('-r, --repo <slug>', 'Repository slug (overrides default)')
	.action(async function (id, opts) {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner(`Fetching PR #${id}...`).start() : null;
		try {
			const data = await getPullRequest(connectionFor(this, 'bitbucket'), id, opts.repo);
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
			const comments = await getPullRequestComments(connectionFor(this, 'bitbucket'), id, opts.repo);
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
			const files = await getPullRequestDiffstat(connectionFor(this, 'bitbucket'), id, opts.repo);
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
			const activities = await getPullRequestActivity(connectionFor(this, 'bitbucket'), id, opts.repo);
			if (s) s.success({ text: `${activities.length} activity item(s)` });
			if (mode === 'json') outputJson(curateActivityJson(activities));
			else if (mode === 'plain') plainPrActivity(activities);
			else formatPrActivity(activities);
		} catch (err) {
			if (s) s.error({ text: `Failed to fetch activity for PR #${id}` });
			handleError(err, err.url || 'bitbucket');
		}
	});

function lineNumber(value) {
	const line = Number(value);
	if (!Number.isInteger(line) || line < 1) throw new InvalidArgumentError('Use a positive line number.');
	return line;
}

const REPO_HELP = 'Repository slug (overrides default)';
const REVIEWER_HELP = 'Reviewer account ID or {UUID} (repeatable)';

pr.command('create')
	.description('Create a pull request')
	.requiredOption('-t, --title <text>', 'Title')
	.requiredOption('-s, --source <branch>', 'Source branch')
	.option('--destination <branch>', 'Destination branch (default: the repository main branch)')
	.option('-d, --description <text>', 'Description (Markdown)')
	.option('--description-file <path>', 'Read the description from a file ("-" for standard input)')
	.option('--reviewer <id>', REVIEWER_HELP, collect, [])
	.option('--close-source-branch', 'Delete the source branch after merge')
	.option('-r, --repo <slug>', REPO_HELP)
	.action(async function (opts) {
		await runWrite(this, actions.create, () => ({
			repo: opts.repo,
			title: opts.title,
			source: opts.source,
			destination: opts.destination,
			description: readText(opts.description, opts.descriptionFile, '--description-file'),
			reviewers: opts.reviewer,
			closeSourceBranch: opts.closeSourceBranch,
		}));
	});

pr.command('edit <id>')
	.description('Change the title, description, destination, or reviewers of a pull request')
	.option('-t, --title <text>', 'New title')
	.option('-d, --description <text>', 'New description (Markdown)')
	.option('--description-file <path>', 'Read the description from a file ("-" for standard input)')
	.option('--destination <branch>', 'New destination branch')
	.option('--reviewer <id>', `${REVIEWER_HELP}; replaces the current reviewers`, collect)
	.option('-r, --repo <slug>', REPO_HELP)
	.action(async function (id, opts) {
		await runWrite(this, actions.edit, () => ({
			id,
			repo: opts.repo,
			title: opts.title,
			description: readText(opts.description, opts.descriptionFile, '--description-file'),
			destination: opts.destination,
			reviewers: opts.reviewer,
		}));
	});

pr.command('merge <id>')
	.description('Merge a pull request')
	.option('--strategy <name>', 'merge_commit, squash, or fast_forward (default: the repository setting)')
	.option('-m, --message <text>', 'Merge commit message')
	.option('--close-source-branch', 'Delete the source branch')
	.option('-r, --repo <slug>', REPO_HELP)
	.action(async function (id, opts) {
		await runWrite(this, actions.merge, () => ({
			id, repo: opts.repo, strategy: opts.strategy, message: opts.message, closeSourceBranch: opts.closeSourceBranch,
		}));
	});

for (const [name, action, description] of [
	['decline', actions.decline, 'Decline a pull request'],
	['approve', actions.approve, 'Approve a pull request as yourself (a Bitbucket review, not `dev pending approve`)'],
	['unapprove', actions.unapprove, 'Remove your approval from a pull request'],
	['request-changes', actions.requestChanges, 'Request changes on a pull request'],
]) {
	pr.command(`${name} <id>`)
		.description(description)
		.option('-r, --repo <slug>', REPO_HELP)
		.action(async function (id, opts) {
			await runWrite(this, action, () => ({ id, repo: opts.repo }));
		});
}

const comment = pr.command('comment')
	.description('Add, edit, or delete pull request comments');

comment.command('add <id> [text]')
	.description('Add a comment (Markdown), optionally on a file or line')
	.option('-F, --file <path>', FILE_HELP)
	.option('--path <file>', 'Comment on this file of the diff')
	.option('--line <number>', 'Comment on this line of the new version of --path', lineNumber)
	.option('-r, --repo <slug>', REPO_HELP)
	.action(async function (id, text, opts) {
		await runWrite(this, actions.commentAdd, () => ({
			id, repo: opts.repo, body: readText(text, opts.file), path: opts.path, line: opts.line,
		}));
	});

comment.command('edit <id> <commentId> [text]')
	.description('Replace the text of a comment')
	.option('-F, --file <path>', FILE_HELP)
	.option('-r, --repo <slug>', REPO_HELP)
	.action(async function (id, commentId, text, opts) {
		await runWrite(this, actions.commentEdit, () => ({ id, commentId, repo: opts.repo, body: readText(text, opts.file) }));
	});

comment.command('delete <id> <commentId>')
	.alias('rm')
	.description('Delete a comment')
	.option('-r, --repo <slug>', REPO_HELP)
	.action(async function (id, commentId, opts) {
		await runWrite(this, actions.commentDelete, () => ({ id, commentId, repo: opts.repo }));
	});

export default pr;
