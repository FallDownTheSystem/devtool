import { get } from '../config/store.js';

const BASE_URL = 'https://api.bitbucket.org/2.0';

function authHeader() {
	const email = get('bitbucket.email');
	const token = get('bitbucket.token');
	return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

function repoPath(repoOverride) {
	const workspace = get('bitbucket.workspace');
	const repo = repoOverride || get('bitbucket.defaultRepo');
	return `/repositories/${workspace}/${repo}`;
}

async function request(path, params = {}) {
	const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null) url.searchParams.set(k, v);
	}

	const res = await fetch(url, {
		headers: {
			'Authorization': authHeader(),
			'Accept': 'application/json',
		},
	});

	if (!res.ok) {
		const err = new Error(`Bitbucket API error: ${res.status} ${res.statusText}`);
		err.status = res.status;
		err.url = url.toString();
		throw err;
	}

	return res.json();
}

async function paginate(path, params = {}) {
	const results = [];
	let data = await request(path, params);
	results.push(...(data.values || []));

	while (data.next) {
		data = await request(data.next);
		results.push(...(data.values || []));
	}

	return results;
}

export async function listPullRequests(options = {}) {
	const { state = 'OPEN', author, repo } = options;
	const path = `${repoPath(repo)}/pullrequests`;
	const params = { state, pagelen: 50 };

	const prs = await paginate(path, params);

	if (author) {
		const authorLower = author.toLowerCase();
		return prs.filter((pr) =>
			pr.author.display_name.toLowerCase().includes(authorLower)
			|| pr.author.nickname?.toLowerCase().includes(authorLower)
		);
	}

	return prs;
}

export async function getPullRequest(id, repo) {
	return request(`${repoPath(repo)}/pullrequests/${id}`);
}

export async function getPullRequestComments(id, repo) {
	return paginate(`${repoPath(repo)}/pullrequests/${id}/comments`);
}

export async function getPullRequestDiffstat(id, repo) {
	return paginate(`${repoPath(repo)}/pullrequests/${id}/diffstat`);
}

export async function getPullRequestActivity(id, repo) {
	return paginate(`${repoPath(repo)}/pullrequests/${id}/activity`);
}
