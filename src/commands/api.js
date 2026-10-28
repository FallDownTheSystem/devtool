import { Command } from 'commander';
import * as bitbucket from '../clients/bitbucket.js';
import { site } from '../clients/jira.js';
import * as confluence from '../clients/confluence.js';
import { listConnections, resolveIndex, types } from '../config/store.js';
import { apiUrl, relativePath, parseQuery, select, parseSelect, nextPageUrl, collectAllPages } from '../utils/api.js';
import { apiError, timeoutSignal } from '../utils/http.js';
import { handleError } from '../utils/errors.js';
import { getOutputMode } from '../utils/mode.js';
import { collect } from '../utils/write.js';

// A Jira connection reaches Server/Data Center or Cloud, and its site decides the client.
const jira = { apiTarget: async (connection) => (await site(connection)).client.apiTarget(connection) };
const clients = { bitbucket, jira, confluence, serviceDesk: jira };

// The only POST requests `dev api` sends. Each endpoint takes its query in the body and changes nothing;
// every write goes through the write commands and their approval flow instead.
export const READ_ONLY_POST = {
	bitbucket: [],
	jira: [
		// JQL search; the POST form takes long JQL in the body and returns the same result as GET.
		'/rest/api/2/search',
		// Jira Cloud: the enhanced JQL search, and the count of issues a query matches.
		'/rest/api/3/search/jql',
		'/rest/api/3/search/approximate-count',
	],
	confluence: [],
	serviceDesk: [
		// Enhanced JQL search; the POST form of GET /rest/api/3/search/jql, for long queries.
		'/rest/api/3/search/jql',
		// Counts the issues a JQL query matches.
		'/rest/api/3/search/approximate-count',
	],
};

function isJson(contentType) {
	return /^application\/(?:[\w.+-]+\+)?json$/.test(contentType?.split(';')[0].trim().toLowerCase() || '');
}

// Redirects are not followed, so the Authorization header is never replayed to another location.
async function send(url, { headers, title }, body) {
	const res = await fetch(url, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { 'Accept': 'application/json', ...headers, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: 'manual',
		signal: timeoutSignal(),
	});
	if (res.status >= 300 && res.status < 400) {
		const err = new Error(`${title} answered with a redirect (${res.status}); dev api does not follow redirects. Check the path and the base URL of the connection.`);
		err.url = url.toString();
		throw err;
	}
	if (!res.ok) throw await apiError(title, res, url);
	const text = await res.text();
	return { text, json: isJson(res.headers.get('content-type')) && text ? JSON.parse(text) : undefined };
}

function connectionFor(ref) {
	const connection = listConnections()[resolveIndex(ref)];
	if (!clients[connection.type]) {
		throw new Error(`dev api does not support ${types[connection.type].title} connections. Supported types: ${Object.keys(clients).join(', ')}.`);
	}
	return connection;
}

function postBody(type, relative, json) {
	const path = relative.split('?')[0];
	if (!READ_ONLY_POST[type].includes(path)) {
		const allowed = READ_ONLY_POST[type].join(', ') || 'none';
		throw new Error(`--post is allowed only for read-only POST endpoints. For ${types[type].title}: ${allowed}.`);
	}
	try {
		return JSON.parse(json);
	} catch {
		throw new Error('--post must be valid JSON.');
	}
}

function nextHint(base, next) {
	console.error(`More results: add --all-pages, or request the next page with \`dev api <connection> '${relativePath(base, next)}'\`.`);
}

const api = new Command('api')
	.description('Read any REST endpoint of a Bitbucket, Jira, Confluence, or Service Desk connection (read-only)')
	.argument('<connection>', 'Connection name, or a type for its default connection (as --connection)')
	.argument('<path>', 'Path relative to the connection\'s base URL; may include a query')
	.option('-q, --query <key=value>', 'Add a query parameter (repeatable)', collect, [])
	.option('--select <expr>', 'Project the JSON: dot paths, [] for each item, {a,b} to pick keys, e.g. issues[].{key,fields.summary}')
	.option('--all-pages', 'Follow pagination and return all items (up to --limit)')
	.option('--limit <n>', 'Most items --all-pages collects', '1000')
	.option('--raw', 'Print the response body unchanged')
	.option('--post <json>', 'Send this JSON body with POST; only for the read-only POST endpoints listed below')
	.addHelpText('after', `
Read-only: dev api sends GET requests, plus POST to a few endpoints that only read (listed below).
Writes go through the write commands, which hold each change for approval. The connection's
credentials are added by the CLI and never printed; paths that could leave its site are rejected.

Base URLs:
  jira, serviceDesk   the site, e.g. /rest/api/2/... or /rest/api/3/...
  confluence          Cloud: <site>/wiki; Server/Data Center: the base URL with its context path
  bitbucket           https://api.bitbucket.org/2.0, e.g. /repositories/<workspace>/<repo>

Read-only POST endpoints (with --post '<json>'):
  jira                ${READ_ONLY_POST.jira.join(', ')}
  serviceDesk         ${READ_ONLY_POST.serviceDesk.join(', ')}

Examples:
  dev api jira /rest/api/2/issue/PROJ-1/editmeta --select 'fields[].{name,required,schema.type}'
  dev api jira /rest/api/2/issue/PROJ-1 --query fields=customfield_15300,timetracking,resolution
  dev api jira /rest/api/2/search --query jql='project = PROJ' --all-pages --select 'issues[].key'
  dev api serviceDesk /rest/api/3/field --select '[].{id,name,schema}'
  dev api serviceDesk /rest/api/3/search/jql --post '{"jql":"project = TUKI","fields":["summary"]}'
  dev api confluence /rest/api/content/123 --query expand=version,ancestors,metadata.labels
  dev api confluence /api/v2/spaces --all-pages --select 'results[].key'
  dev api bitbucket /repositories/my-workspace/my-repo/pullrequests --query state=MERGED

Pagination styles followed by --all-pages: startAt/maxResults/total (Jira), nextPageToken/isLast
(Jira Cloud), _links.next (Confluence, Service Desk API), next (Bitbucket). Without it, one page is
returned and a hint on standard error shows the next page.

Output: JSON, indented by default and compact with --plain or --json; non-JSON bodies as text.`)
	.action(async function (ref, path, opts) {
		const mode = getOutputMode(this);
		try {
			if (opts.raw && (opts.select || opts.allPages)) throw new Error('--raw prints the body unchanged; it cannot be combined with --select or --all-pages.');
			if (opts.post !== undefined && opts.allPages) throw new Error('--all-pages works with GET requests only.');
			if (opts.select) parseSelect(opts.select);
			const limit = parseInt(opts.limit, 10);
			if (!(limit > 0)) throw new Error('--limit must be a positive number.');

			const connection = connectionFor(ref);
			const target = { ...await clients[connection.type].apiTarget(connection), title: types[connection.type].title };
			const url = apiUrl(target.base, path, parseQuery(opts.query));
			const body = opts.post === undefined ? undefined : postBody(connection.type, relativePath(target.base, url), opts.post);

			let data;
			if (opts.allPages) {
				const result = await collectAllPages(async (u) => {
					const page = await send(u, target);
					if (page.json === undefined) throw new Error('--all-pages needs JSON responses; this endpoint returned something else.');
					return page.json;
				}, url, target.base, limit);
				data = result.data;
				if (result.truncated) console.error(`Stopped at ${limit} items; raise --limit to collect more.`);
			} else {
				const response = await send(url, target, body);
				if (opts.raw || response.json === undefined) {
					process.stdout.write(response.text.endsWith('\n') || !response.text ? response.text : `${response.text}\n`);
					return;
				}
				data = response.json;
				const next = nextPageUrl(data, url, target.base);
				if (next && body === undefined) nextHint(target.base, next);
			}
			const output = opts.select ? select(data, opts.select) : data;
			console.log(mode === 'rich' ? JSON.stringify(output, null, 2) : JSON.stringify(output));
		} catch (err) {
			handleError(err, err.url || `api ${ref} ${path}`);
		}
	});

export default api;
