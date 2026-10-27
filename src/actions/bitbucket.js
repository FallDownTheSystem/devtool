import * as client from '../clients/bitbucket.js';
import { requireText } from './require.js';

// The repository is fixed when the action is prepared, so changing defaultRepo before approval cannot redirect it.
function withRepo(connection, input) {
	return { ...input, repo: client.resolveRepo(connection, input.repo) };
}

function pullRequestState(pr) {
	return {
		title: pr.title,
		source: pr.source?.branch?.name,
		destination: pr.destination?.branch?.name,
		commit: pr.source?.commit?.hash,
	};
}

// Shows which pull request the action affects.
async function previewPullRequest(connection, p) {
	return pullRequestState(await client.getPullRequest(connection, p.id, p.repo));
}

// Merging and reviewing cannot pin a commit in the API, so the previewed head and destination are compared
// before the request; otherwise commits pushed after the preview would be merged or approved unseen.
async function verifyPullRequest(connection, p) {
	const now = pullRequestState(await client.getPullRequest(connection, p.id, p.repo));
	if (now.commit !== p.commit || now.destination !== p.destination) {
		const err = new Error(`Pull request #${p.id} changed after the preview (head ${p.commit} → ${now.commit}, destination ${p.destination} → ${now.destination}). Reject this action and request it again.`);
		err.stale = true;
		throw err;
	}
}

function prLine(p) {
	return `#${p.id} ${p.title} (${p.source} → ${p.destination})`;
}

function simple(name, verb, done, run, { pinned = false } = {}) {
	return {
		name: `pr.${name}`,
		type: 'bitbucket',
		prepare: withRepo,
		preview: previewPullRequest,
		...(pinned && { verify: verifyPullRequest }),
		summary: (p) => `${verb} pull request #${p.id} in ${p.repo}`,
		details: (p) => [['Pull request', prLine(p)], ...(pinned ? [['Head commit', p.commit]] : [])],
		run: (connection, p) => run(connection, p.id, p.repo),
		report: (_, p) => ({ message: `${done} pull request #${p.id}`, json: { repo: p.repo, id: Number(p.id) } }),
	};
}

export const create = {
	name: 'pr.create',
	type: 'bitbucket',
	async prepare(connection, input) {
		if (!input.title) throw new Error('A title is required. Pass --title <text>.');
		if (!input.source) throw new Error('A source branch is required. Pass --source <branch>.');
		return withRepo(connection, input);
	},
	summary: (p) => `Create a pull request in ${p.repo}: ${p.title}`,
	details: (p) => [
		['Branches', `${p.source} → ${p.destination || '(repository main branch)'}`],
		['Title', p.title],
		...(p.reviewers?.length ? [['Reviewers', p.reviewers.join(', ')]] : []),
		...(p.closeSourceBranch ? [['Close source branch', 'yes']] : []),
		...(p.description !== undefined ? [['Description', p.description || '(empty)']] : []),
	],
	run: (connection, p) => client.createPullRequest(connection, p),
	report: (pr, p) => ({
		message: `Created pull request #${pr.id} in ${p.repo}`,
		json: { repo: p.repo, id: pr.id, url: pr.links?.html?.href || null },
	}),
};

// The preview stores the current PR under `current`, because the new title and destination use the plain names.
export const edit = {
	name: 'pr.edit',
	type: 'bitbucket',
	async prepare(connection, input) {
		const { title, description, destination, reviewers } = input;
		if ([title, description, destination, reviewers].every((v) => v === undefined)) {
			throw new Error('Nothing to change. Pass --title, --description, --destination, or --reviewer.');
		}
		return withRepo(connection, input);
	},
	preview: async (connection, p) => ({ current: prLine({ id: p.id, ...await previewPullRequest(connection, p) }) }),
	summary: (p) => `Edit pull request #${p.id} in ${p.repo}`,
	details: (p) => [
		['Pull request', p.current],
		...(p.title !== undefined ? [['New title', p.title]] : []),
		...(p.destination !== undefined ? [['New destination', p.destination]] : []),
		...(p.reviewers !== undefined ? [['Reviewers', p.reviewers.join(', ') || '(none)']] : []),
		...(p.description !== undefined ? [['New description', p.description || '(empty)']] : []),
	],
	run: (connection, p) => client.updatePullRequest(connection, p.id, p),
	report: (_, p) => ({ message: `Updated pull request #${p.id}`, json: { repo: p.repo, id: Number(p.id) } }),
};

// A merge that Bitbucket finishes in the background answers without a merged PR, so success is reported
// only for a MERGED state.
export const merge = {
	name: 'pr.merge',
	type: 'bitbucket',
	prepare: withRepo,
	preview: previewPullRequest,
	verify: verifyPullRequest,
	summary: (p) => `Merge pull request #${p.id} in ${p.repo}`,
	details: (p) => [
		['Pull request', prLine(p)],
		['Head commit', p.commit],
		['Strategy', p.strategy || 'repository default'],
		...(p.closeSourceBranch ? [['Close source branch', 'yes']] : []),
		...(p.message !== undefined ? [['Merge message', p.message]] : []),
	],
	run: (connection, p) => client.mergePullRequest(connection, p.id, p),
	report: (pr, p) => ({
		message: pr?.state === 'MERGED'
			? `Merged pull request #${p.id}`
			: `Merge of pull request #${p.id} accepted; it completes in the background. Check it with \`dev pr view ${p.id}\`.`,
		json: { repo: p.repo, id: Number(p.id), state: pr?.state || null },
	}),
};

export const decline = simple('decline', 'Decline', 'Declined', client.declinePullRequest);
export const approve = simple('approve', 'Approve', 'Approved', client.approvePullRequest, { pinned: true });
export const unapprove = simple('unapprove', 'Remove your approval from', 'Removed your approval from', client.unapprovePullRequest);
export const requestChanges = simple('request-changes', 'Request changes on', 'Requested changes on', client.requestChanges, { pinned: true });

export const commentAdd = {
	name: 'pr.comment.add',
	type: 'bitbucket',
	async prepare(connection, input) {
		requireText(input.body, 'comment');
		if (input.line && !input.path) throw new Error('--line needs --path.');
		return withRepo(connection, input);
	},
	preview: previewPullRequest,
	summary: (p) => `Comment on pull request #${p.id} in ${p.repo}`,
	details: (p) => [
		['Pull request', prLine(p)],
		...(p.path ? [['Location', p.line ? `${p.path}:${p.line}` : p.path]] : []),
		['Comment', p.body],
	],
	run: (connection, p) => client.addPullRequestComment(connection, p.id, p),
	report: (comment, p) => ({
		message: `Added comment ${comment.id} to pull request #${p.id}`,
		json: { repo: p.repo, id: Number(p.id), commentId: comment.id },
	}),
};

async function currentComment(connection, p) {
	const comment = await client.getPullRequestComment(connection, p.id, p.commentId, p.repo);
	return { author: comment.user?.display_name || 'Unknown', current: comment.content?.raw || '' };
}

export const commentEdit = {
	name: 'pr.comment.edit',
	type: 'bitbucket',
	async prepare(connection, input) {
		requireText(input.body, 'comment');
		return withRepo(connection, input);
	},
	preview: currentComment,
	summary: (p) => `Edit comment ${p.commentId} on pull request #${p.id} in ${p.repo}`,
	details: (p) => [['Current text', p.current], ['New text', p.body]],
	run: (connection, p) => client.updatePullRequestComment(connection, p.id, p.commentId, p),
	report: (_, p) => ({ message: `Updated comment ${p.commentId}`, json: { repo: p.repo, id: Number(p.id), commentId: Number(p.commentId) } }),
};

export const commentDelete = {
	name: 'pr.comment.delete',
	type: 'bitbucket',
	prepare: withRepo,
	preview: currentComment,
	summary: (p) => `Delete comment ${p.commentId} on pull request #${p.id} in ${p.repo}`,
	details: (p) => [['Author', p.author], ['Comment', p.current]],
	run: (connection, p) => client.deletePullRequestComment(connection, p.id, p.commentId, p.repo),
	report: (_, p) => ({ message: `Deleted comment ${p.commentId}`, json: { repo: p.repo, id: Number(p.id), commentId: Number(p.commentId) } }),
};
