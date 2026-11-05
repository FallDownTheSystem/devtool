import { request, getIssueBrief, getMyself } from './jiraServer.js';

// Tempo Timesheets on Jira Server/Data Center: the plugin's REST API on the Jira site, with the
// connection's own credentials. Worklogs are mapped to and from one shape shared with tempoCloud.js:
//   { id, issueKey, issueId, worker, date: 'YYYY-MM-DD', start: 'HH:MM', seconds, billableSeconds,
//     comment, attributes: { <key>: <value> } }

const TIMESHEETS = '/rest/tempo-timesheets/4/worklogs';

export { getIssueBrief };

// Tempo addresses a Server user by the user key (e.g. JIRAUSER38404), not the user name.
export async function currentWorker(connection) {
	const me = await getMyself(connection);
	return { id: me.key, name: me.displayName || me.name || me.key };
}

// Live sites answer with `started` and `worker`; the published schema names them `startDate` and
// `workerKey`, so both are read.
function fromTempo(w) {
	const started = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(w.started || w.startDate || '') || [];
	return {
		id: String(w.tempoWorklogId),
		issueKey: w.issue?.key || null,
		issueId: w.issue?.id != null ? String(w.issue.id) : w.originTaskId != null ? String(w.originTaskId) : null,
		worker: w.worker || w.workerKey || null,
		date: started[1] || null,
		start: started[2] ? `${started[2]}:${started[3]}` : null,
		seconds: w.timeSpentSeconds ?? 0,
		// Server Tempo always answers 0 here, whatever was logged, so the value carries no meaning.
		billableSeconds: null,
		comment: w.comment || '',
		attributes: Object.fromEntries(Object.entries(w.attributes || {}).map(([key, a]) => [key, a?.value ?? null])),
	};
}

function attributesBody(attributes) {
	return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, { value }]));
}

function started(log) {
	return `${log.date} ${log.start}:00.000`;
}

export async function searchWorklogs(connection, { from, to, worker }) {
	const data = await request(connection, `${TIMESHEETS}/search`, {}, { method: 'POST', body: { from, to, worker: [worker] } });
	return (Array.isArray(data) ? data : []).map(fromTempo);
}

export async function getWorklog(connection, id) {
	return fromTempo(await request(connection, `${TIMESHEETS}/${encodeURIComponent(id)}`));
}

export async function createWorklog(connection, log) {
	const data = await request(connection, TIMESHEETS, {}, {
		method: 'POST',
		body: {
			worker: log.worker,
			originTaskId: log.issueKey,
			started: started(log),
			timeSpentSeconds: log.seconds,
			comment: log.comment,
			endDate: null,
			includeNonWorkingDays: false,
			attributes: attributesBody(log.attributes),
		},
	});
	// One worklog per day of the range; without an end date that is one.
	return fromTempo(Array.isArray(data) ? data[0] : data);
}

// The worker and the issue cannot change on update; the other fields are sent in full.
export async function updateWorklog(connection, id, log) {
	const data = await request(connection, `${TIMESHEETS}/${encodeURIComponent(id)}`, {}, {
		method: 'PUT',
		body: {
			started: started(log),
			timeSpentSeconds: log.seconds,
			comment: log.comment,
			attributes: attributesBody(log.attributes),
		},
	});
	return data ? fromTempo(Array.isArray(data) ? data[0] : data) : null;
}

export async function deleteWorklog(connection, id) {
	await request(connection, `${TIMESHEETS}/${encodeURIComponent(id)}`, {}, { method: 'DELETE' });
}

// { key, name, type, required, values: [{ value, name }] }; removed list values are left out.
export async function getAttributes(connection) {
	const data = await request(connection, '/rest/tempo-core/1/work-attribute');
	return (Array.isArray(data) ? data : []).map((a) => ({
		key: a.key,
		name: a.name || a.key,
		type: a.type?.value || a.type?.name || a.type || null,
		required: Boolean(a.required),
		values: (a.staticListValues || []).filter((v) => !v.removed).map((v) => ({ value: v.value, name: v.name || v.value })),
	}));
}
