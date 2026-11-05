import { jsonInit, apiError } from '../utils/http.js';
import { label, TEMPO_CLOUD_HOSTS } from '../config/store.js';
import { getIssueBrief, getMyself, searchIssues } from './jiraCloud.js';

// Tempo Cloud: its own API host and API token, apart from the Jira Cloud site. Jira Cloud supplies
// the account ID and the numeric issue IDs that Tempo takes, and the issue keys that it does not
// return. Worklogs are mapped to and from the shape of tempoServer.js.

export { getIssueBrief };

const MAX_ATTEMPTS = 4;

function base(connection) {
	const host = connection.tempoApiUrl || TEMPO_CLOUD_HOSTS[0];
	// The host is validated on save; the check here keeps a hand-edited config from sending the token elsewhere.
	if (!TEMPO_CLOUD_HOSTS.includes(host)) throw new Error(`Tempo API host "${host}" is not one of ${TEMPO_CLOUD_HOSTS.join(', ')}.`);
	return new URL(host);
}

function token(connection) {
	if (connection.tempoToken) return connection.tempoToken;
	const name = label(connection);
	throw new Error(`Tempo Cloud needs its own API token; the Atlassian API token does not work there. Create one in Tempo > Settings > API integration, then run \`dev config token ${name} --field tempoToken\`.`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Tempo Cloud allows a few requests per second and answers 429 beyond that, before it processes the
// request, so a retry cannot apply a write twice.
async function request(connection, path, { method, body, params = {}, url } = {}) {
	const target = url || new URL(`/4${path}`, base(connection));
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null && v !== '') target.searchParams.set(k, v);
	}
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(target, { ...jsonInit({ method, body, headers: { 'Authorization': `Bearer ${token(connection)}` } }), redirect: 'manual' });
		if (res.status === 429 && attempt < MAX_ATTEMPTS) {
			const after = Number(res.headers.get('retry-after'));
			await wait((Number.isFinite(after) && after > 0 ? after : attempt) * 1000);
			continue;
		}
		if (!res.ok) throw await apiError('Tempo', res, target);
		const text = await res.text();
		return text ? JSON.parse(text) : null;
	}
}

// Follows `metadata.next`, which must stay on the Tempo host the token was sent to.
async function collect(connection, path, params) {
	const items = [];
	let data = await request(connection, path, { params });
	for (;;) {
		items.push(...(data?.results || []));
		const next = data?.metadata?.next;
		if (!next) return items;
		const url = new URL(next);
		if (url.origin !== base(connection).origin) throw new Error(`Tempo returned a next page on another host (${url.origin}).`);
		data = await request(connection, null, { url });
	}
}

export async function currentWorker(connection) {
	const me = await getMyself(connection);
	return { id: me.accountId, name: me.displayName || me.accountId };
}

// The hour of a start time may have one digit: "9:15:00".
function clock(time) {
	const match = /^(\d{1,2}):(\d{2})/.exec(time || '');
	return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
}

function fromTempo(w) {
	return {
		id: String(w.tempoWorklogId),
		issueKey: null,
		issueId: w.issue?.id != null ? String(w.issue.id) : null,
		worker: w.author?.accountId || null,
		date: w.startDate || null,
		start: clock(w.startTime),
		seconds: w.timeSpentSeconds ?? 0,
		billableSeconds: w.billableSeconds ?? null,
		comment: w.description || '',
		attributes: Object.fromEntries((w.attributes?.values || []).map((a) => [a.key, a.value ?? null])),
	};
}

// Tempo Cloud names issues only by ID; Jira Cloud supplies the keys.
async function withKeys(connection, worklogs) {
	const ids = [...new Set(worklogs.map((w) => w.issueId).filter(Boolean))];
	const keys = new Map();
	for (let i = 0; i < ids.length; i += 100) {
		const chunk = ids.slice(i, i + 100);
		const { issues } = await searchIssues(connection, `id in (${chunk.join(',')})`, chunk.length);
		for (const issue of issues) keys.set(String(issue.id), issue.key);
	}
	return worklogs.map((w) => ({ ...w, issueKey: keys.get(w.issueId) || null }));
}

// Seconds are required: "HH:mm:ss".
function body(log) {
	return {
		authorAccountId: log.worker,
		startDate: log.date,
		startTime: `${log.start}:00`,
		timeSpentSeconds: log.seconds,
		billableSeconds: log.billableSeconds ?? log.seconds,
		description: log.comment,
		attributes: Object.entries(log.attributes).map(([key, value]) => ({ key, value })),
	};
}

export async function searchWorklogs(connection, { from, to, worker }) {
	const worklogs = await collect(connection, `/worklogs/user/${encodeURIComponent(worker)}`, { from, to, limit: 1000 });
	return withKeys(connection, worklogs.map(fromTempo));
}

export async function getWorklog(connection, id) {
	const [worklog] = await withKeys(connection, [fromTempo(await request(connection, `/worklogs/${encodeURIComponent(id)}`))]);
	return worklog;
}

export async function createWorklog(connection, log) {
	const data = await request(connection, '/worklogs', { method: 'POST', body: { ...body(log), issueId: Number(log.issueId) } });
	return { ...fromTempo(data), issueKey: log.issueKey };
}

// PUT replaces the whole worklog, so every field is sent; a missing start time would reset it to 00:00.
export async function updateWorklog(connection, id, log) {
	const data = await request(connection, `/worklogs/${encodeURIComponent(id)}`, { method: 'PUT', body: body(log) });
	return data ? { ...fromTempo(data), issueKey: log.issueKey } : null;
}

export async function deleteWorklog(connection, id) {
	await request(connection, `/worklogs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// A static list stores values (often generated IDs) and shows their names.
export async function getAttributes(connection) {
	const attributes = await collect(connection, '/work-attributes', { limit: 1000 });
	return attributes.map((a) => ({
		key: a.key,
		name: a.name || a.key,
		type: a.type || null,
		required: Boolean(a.required),
		values: (a.values || []).map((value) => ({ value, name: a.names?.[value] || value })),
	}));
}
