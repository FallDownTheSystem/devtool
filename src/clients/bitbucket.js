import { jsonInit, apiError } from '../utils/http.js';

const BASE_URL = 'https://api.bitbucket.org/2.0';

function authHeader(connection) {
	return 'Basic ' + Buffer.from(`${connection.email}:${connection.token}`).toString('base64');
}

// The base URL and authentication that `dev api` sends raw read requests with.
export function apiTarget(connection) {
	return { base: new URL(BASE_URL), headers: { 'Authorization': authHeader(connection) } };
}

export function resolveRepo(connection, repoOverride) {
	const repo = repoOverride || connection.defaultRepo;
	if (!repo) throw new Error('No repository specified. Pass --repo <slug> or set defaultRepo on the Bitbucket connection.');
	return repo;
}

function repoPath(connection, repoOverride) {
	return `/repositories/${connection.workspace}/${resolveRepo(connection, repoOverride)}`;
}

function prPath(connection, repo, id, suffix = '') {
	return `${repoPath(connection, repo)}/pullrequests/${id}${suffix}`;
}

async function request(connection, path, params = {}, { method, body } = {}) {
	const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null) url.searchParams.set(k, v);
	}

	const res = await fetch(url, jsonInit({ method, body, headers: { 'Authorization': authHeader(connection) } }));
	if (!res.ok) throw await apiError('Bitbucket', res, url);
	// Deletes answer 204 and a merge finished in the background answers 202, both possibly without a body.
	const text = await res.text();
	return text ? JSON.parse(text) : null;
}

async function paginate(connection, path, params = {}) {
	const results = [];
	let data = await request(connection, path, params);
	results.push(...(data.values || []));

	while (data.next) {
		data = await request(connection, data.next);
		results.push(...(data.values || []));
	}

	return results;
}

export async function listPullRequests(connection, options = {}) {
	const { state = 'OPEN', author, repo } = options;
	const path = `${repoPath(connection, repo)}/pullrequests`;
	const params = { state, pagelen: 50 };

	const prs = await paginate(connection, path, params);

	if (author) {
		const authorLower = author.toLowerCase();
		return prs.filter((pr) =>
			pr.author.display_name.toLowerCase().includes(authorLower)
			|| pr.author.nickname?.toLowerCase().includes(authorLower)
		);
	}

	return prs;
}

export async function getPullRequest(connection, id, repo) {
	return request(connection, prPath(connection, repo, id));
}

export async function getPullRequestComments(connection, id, repo) {
	return paginate(connection, prPath(connection, repo, id, '/comments'));
}

export async function getPullRequestComment(connection, id, commentId, repo) {
	return request(connection, prPath(connection, repo, id, `/comments/${commentId}`));
}

export async function getPullRequestDiffstat(connection, id, repo) {
	return paginate(connection, prPath(connection, repo, id, '/diffstat'));
}

export async function getPullRequestActivity(connection, id, repo) {
	return paginate(connection, prPath(connection, repo, id, '/activity'));
}

// A reviewer is an account ID, or a UUID in braces as Bitbucket prints it.
function reviewer(id) {
	return id.startsWith('{') ? { uuid: id } : { account_id: id };
}

export async function createPullRequest(connection, { repo, title, source, destination, description, reviewers = [], closeSourceBranch }) {
	const body = { title, source: { branch: { name: source } } };
	if (destination) body.destination = { branch: { name: destination } };
	if (description !== undefined) body.description = description;
	if (reviewers.length) body.reviewers = reviewers.map(reviewer);
	if (closeSourceBranch !== undefined) body.close_source_branch = closeSourceBranch;
	return request(connection, `${repoPath(connection, repo)}/pullrequests`, {}, { method: 'POST', body });
}

// Atlassian documents that this PUT drops any field the body omits, and reports disagree, so the fields
// that are not changing are read just before the update and sent back as they are; reading them any
// earlier would remove a reviewer added in between.
export async function updatePullRequest(connection, id, { repo, title, description, destination, reviewers }) {
	const current = await getPullRequest(connection, id, repo);
	const body = {
		title: title ?? current.title,
		description: description ?? current.description ?? '',
		reviewers: (reviewers ?? (current.reviewers || []).map((r) => r.uuid)).map(reviewer),
	};
	if (destination !== undefined) body.destination = { branch: { name: destination } };
	return request(connection, prPath(connection, repo, id), {}, { method: 'PUT', body });
}

export async function mergePullRequest(connection, id, { repo, strategy, message, closeSourceBranch }) {
	const body = {};
	if (strategy) body.merge_strategy = strategy;
	if (message !== undefined) body.message = message;
	if (closeSourceBranch !== undefined) body.close_source_branch = closeSourceBranch;
	return request(connection, prPath(connection, repo, id, '/merge'), {}, { method: 'POST', body });
}

export async function declinePullRequest(connection, id, repo) {
	return request(connection, prPath(connection, repo, id, '/decline'), {}, { method: 'POST' });
}

export async function approvePullRequest(connection, id, repo) {
	return request(connection, prPath(connection, repo, id, '/approve'), {}, { method: 'POST' });
}

export async function unapprovePullRequest(connection, id, repo) {
	return request(connection, prPath(connection, repo, id, '/approve'), {}, { method: 'DELETE' });
}

export async function requestChanges(connection, id, repo) {
	return request(connection, prPath(connection, repo, id, '/request-changes'), {}, { method: 'POST' });
}

export async function addPullRequestComment(connection, id, { repo, body, path, line }) {
	const comment = { content: { raw: body } };
	if (path) comment.inline = line ? { path, to: line } : { path };
	return request(connection, prPath(connection, repo, id, '/comments'), {}, { method: 'POST', body: comment });
}

export async function updatePullRequestComment(connection, id, commentId, { repo, body }) {
	return request(connection, prPath(connection, repo, id, `/comments/${commentId}`), {}, {
		method: 'PUT',
		body: { content: { raw: body } },
	});
}

export async function deletePullRequestComment(connection, id, commentId, repo) {
	return request(connection, prPath(connection, repo, id, `/comments/${commentId}`), {}, { method: 'DELETE' });
}
