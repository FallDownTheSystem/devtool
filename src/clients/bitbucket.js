const BASE_URL = 'https://api.bitbucket.org/2.0';

function authHeader(connection) {
	return 'Basic ' + Buffer.from(`${connection.email}:${connection.token}`).toString('base64');
}

function repoPath(connection, repoOverride) {
	const repo = repoOverride || connection.defaultRepo;
	if (!repo) throw new Error('No repository specified. Pass --repo <slug> or set defaultRepo on the Bitbucket connection.');
	return `/repositories/${connection.workspace}/${repo}`;
}

async function request(connection, path, params = {}) {
	const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null) url.searchParams.set(k, v);
	}

	const res = await fetch(url, {
		headers: {
			'Authorization': authHeader(connection),
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
	return request(connection, `${repoPath(connection, repo)}/pullrequests/${id}`);
}

export async function getPullRequestComments(connection, id, repo) {
	return paginate(connection, `${repoPath(connection, repo)}/pullrequests/${id}/comments`);
}

export async function getPullRequestDiffstat(connection, id, repo) {
	return paginate(connection, `${repoPath(connection, repo)}/pullrequests/${id}/diffstat`);
}

export async function getPullRequestActivity(connection, id, repo) {
	return paginate(connection, `${repoPath(connection, repo)}/pullrequests/${id}/activity`);
}
