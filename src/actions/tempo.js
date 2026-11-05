import { JIRA_TYPES } from '../clients/jira.js';
import { tempo } from '../clients/tempo.js';
import { validateClockTime } from '../config/store.js';

// Tempo worklog actions for `dev tempo worklog`, on Jira Server/Data Center and Jira Cloud. Parameters
// hold worklogs in the shape the Tempo clients share (see clients/tempoServer.js), resolved before
// approval: the worker, the issue IDs, the attribute values, and the defaults of the connection.

// The work attributes that have their own options. Their keys are Tempo's standard ones.
export const ATTRIBUTES = [
	{ key: '_WorkType_', option: 'workType', flag: '--work-type', title: 'Work Type' },
	{ key: '_WageType_', option: 'wageType', flag: '--wage-type', title: 'Wage Type', defaultField: 'tempoWageType' },
	{ key: '_PricingMultiplier_', option: 'pricing', flag: '--pricing', title: 'Pricing Multiplier', defaultField: 'tempoPricing' },
];

export const DEFAULT_START = '09:00';

const DAY_SECONDS = 24 * 3600;

export function hours(seconds) {
	return String(Math.round(seconds / 36) / 100);
}

// Decimal hours, with "." or "," as the decimal mark.
export function parseHours(value, what, { allowZero = false } = {}) {
	const text = String(value ?? '').trim().replace(',', '.');
	if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) throw new Error(`${what} "${value ?? ''}" is not a number of hours, e.g. 0.75 or 1.5.`);
	const seconds = Math.round(Number(text) * 3600);
	if (seconds <= 0 && !(allowZero && seconds === 0)) throw new Error(`${what} must be more than 0 hours.`);
	if (seconds > DAY_SECONDS) throw new Error(`${what} ${text} is more than 24 hours.`);
	return seconds;
}

export function requireDate(value, what) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
	const date = match && new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
	if (!date || date.getUTCMonth() !== +match[2] - 1 || date.getUTCDate() !== +match[3]) {
		throw new Error(`${what} "${value ?? ''}" is not a date. Use YYYY-MM-DD, e.g. 2026-11-02.`);
	}
	return match[0];
}

function requireStart(value, what) {
	if (validateClockTime(value)) throw new Error(`${what} "${value}" is not a time. Use HH:MM, e.g. 09:00.`);
	return value.trim().padStart(5, '0');
}

function oneLine(text) {
	return String(text).replace(/\s*\n\s*/g, '; ');
}

// A static-list value is found by its stored value, or by its name; other attribute types take the text.
function attributeValue(definitions, key, raw, flag) {
	const definition = definitions.find((d) => d.key === key);
	if (!definition) throw new Error(`This Tempo site has no work attribute ${key} (${flag}). \`dev tempo attributes\` lists the attributes it has.`);
	if (!definition.values.length) return { value: raw, definition };
	const wanted = raw.toLowerCase();
	const match = definition.values.find((v) => v.value === raw)
		|| definition.values.find((v) => String(v.value).toLowerCase() === wanted)
		|| definition.values.find((v) => String(v.name).toLowerCase() === wanted);
	if (!match) {
		const allowed = definition.values.map((v) => (v.name !== v.value ? `${v.value} (${v.name})` : v.value)).join(', ');
		throw new Error(`"${raw}" is not a ${definition.name} (${flag}). Allowed: ${allowed}.`);
	}
	return { value: match.value, definition };
}

// Resolves the attribute options of each item to { attributes, names }; `names` holds the display names
// of the attributes and values used, for the approval preview.
async function resolveAttributes(connection, client, items) {
	const given = items.some((item) => ATTRIBUTES.some((a) => item[a.option]));
	const definitions = given ? await client.getAttributes(connection) : [];
	const names = {};
	const resolved = items.map((item) => {
		const attributes = {};
		for (const a of ATTRIBUTES) {
			if (!item[a.option]) continue;
			const { value, definition } = attributeValue(definitions, a.key, item[a.option], a.flag);
			attributes[a.key] = value;
			names[a.key] ??= { name: definition.name, values: {} };
			const valueName = definition.values.find((v) => v.value === value)?.name;
			if (valueName && valueName !== value) names[a.key].values[value] = valueName;
		}
		return attributes;
	});
	return { resolved, names };
}

function attributeText(names, key, value) {
	const name = names?.[key]?.values?.[value];
	return name ? `${value} (${name})` : String(value);
}

function attributeTitle(names, key) {
	return names?.[key]?.name || ATTRIBUTES.find((a) => a.key === key)?.title || key;
}

function attributeDetails(names, attributes) {
	return Object.entries(attributes).map(([key, value]) => [attributeTitle(names, key), attributeText(names, key, value)]);
}

function issueText(issue) {
	return [issue.summary, issue.status].filter(Boolean).join(', ');
}

// Every key is checked before anything is held, so a batch with one wrong key stops as a whole.
async function checkIssues(connection, client, keys) {
	const issues = {};
	const problems = [];
	for (const key of [...new Set(keys.map((k) => k.toUpperCase()))]) {
		try {
			const issue = await client.getIssueBrief(connection, key);
			issues[key] = { key: issue.key, id: String(issue.id), summary: issue.fields?.summary || '', status: issue.fields?.status?.name || '' };
		} catch (err) {
			if (err.status !== 404 && err.status !== 400) throw err;
			problems.push(key);
		}
	}
	if (problems.length) throw new Error(`Issue(s) not found, or not visible to you: ${problems.join(', ')}.`);
	return issues;
}

function rowError(batch, index, err) {
	return batch ? new Error(`Row ${index + 1}: ${err.message}`) : err;
}

function pad(text, width) {
	return String(text).padEnd(width);
}

// Aligned text columns; the last column is not padded.
function textTable(rows) {
	const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
	return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : pad(cell, widths[c]))).join('  ').trimEnd());
}

function byDay(logs) {
	const days = new Map();
	for (const log of logs) {
		if (!days.has(log.date)) days.set(log.date, []);
		days.get(log.date).push(log);
	}
	return [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const total = (logs) => logs.reduce((sum, log) => sum + log.seconds, 0);

function logCells(p, log) {
	return [
		log.date, log.issueKey, `${hours(log.seconds)}h`,
		...(p.cloud ? [`${hours(log.billableSeconds)}h`] : []),
		log.start, ATTRIBUTES.map((a) => log.attributes[a.key]).filter(Boolean).join(' '), log.comment,
	];
}

// The batch preview: one table of every row, in date order, with each day's total under its rows.
// It is shown in full, since the rows are the change being approved.
function batchDetails(p) {
	const blank = (cells) => cells.map(() => '');
	const head = ['Date', 'Issue', 'Hours', ...(p.cloud ? ['Billable'] : []), 'Start', 'Attributes', 'Comment'];
	const rows = [head];
	for (const [, logs] of byDay(p.logs)) {
		rows.push(...logs.map((log) => logCells(p, log)));
		const totalRow = blank(head);
		totalRow[1] = 'Day total';
		totalRow[2] = `${hours(total(logs))}h`;
		rows.push(totalRow);
	}
	return [
		['Worker', p.worker.name === p.worker.id ? p.worker.id : `${p.worker.name} (${p.worker.id})`],
		['Issues', textTable(Object.values(p.issues).map((i) => [i.key, issueText(i)])).join('\n')],
		['Worklogs', textTable(rows).join('\n'), { full: true }],
		['Total', `${hours(total(p.logs))}h in ${p.logs.length} worklogs`],
	];
}

function singleDetails(p) {
	const log = p.logs[0];
	const issue = p.issues[log.issueKey];
	return [
		['Issue', `${log.issueKey} (${issueText(issue)})`],
		['Date', log.date],
		['Start', log.start],
		['Hours', hours(log.seconds)],
		...(p.cloud ? [['Billable hours', hours(log.billableSeconds)]] : []),
		['Comment', log.comment || '(none)'],
		...attributeDetails(p.names, log.attributes),
		['Worker', p.worker.name === p.worker.id ? p.worker.id : `${p.worker.name} (${p.worker.id})`],
	];
}

function dateRange(logs) {
	const dates = logs.map((log) => log.date).sort();
	return dates[0] === dates.at(-1) ? `on ${dates[0]}` : `from ${dates[0]} to ${dates.at(-1)}`;
}

function failureReason(err) {
	return oneLine(err.detail || err.message || String(err));
}

// `input` is { batch, rows: [{ date, key, hours, comment, workType, wageType, pricing, start, billableHours }] }.
export const worklogAdd = {
	name: 'tempo.worklog.add',
	type: JIRA_TYPES,
	route: (input) => input.rows[0]?.key,
	async prepare(connection, input) {
		const { cloud, client } = await tempo(connection);
		const items = input.rows.map((row, i) => {
			try {
				if (!row.key) throw new Error('An issue key is required.');
				const seconds = parseHours(row.hours, input.batch ? 'Hours' : '--hours');
				let billableSeconds;
				if (row.billableHours !== undefined && row.billableHours !== '') {
					if (!cloud) throw new Error('Jira Server/Data Center Tempo ignores billable hours; leave out --billable-hours.');
					billableSeconds = parseHours(row.billableHours, input.batch ? 'Billable hours' : '--billable-hours', { allowZero: true });
					if (billableSeconds > seconds) throw new Error(`Billable hours ${hours(billableSeconds)} are more than the ${hours(seconds)} hours logged.`);
				}
				return {
					...row,
					key: row.key.trim().toUpperCase(),
					date: requireDate(row.date, input.batch ? 'Date' : '--date'),
					start: requireStart(row.start || connection.tempoStart || DEFAULT_START, input.batch ? 'Start' : '--start'),
					seconds,
					billableSeconds: cloud ? billableSeconds ?? seconds : undefined,
					...Object.fromEntries(ATTRIBUTES.filter((a) => a.defaultField).map((a) => [a.option, row[a.option] || connection[a.defaultField]])),
				};
			} catch (err) {
				throw rowError(input.batch, i, err);
			}
		});
		const issues = await checkIssues(connection, client, items.map((item) => item.key));
		const { resolved, names } = await resolveAttributes(connection, client, items);
		const worker = await client.currentWorker(connection);
		const logs = items.map((item, i) => ({
			issueKey: issues[item.key].key,
			issueId: issues[item.key].id,
			worker: worker.id,
			date: item.date,
			start: item.start,
			seconds: item.seconds,
			...(cloud && { billableSeconds: item.billableSeconds }),
			comment: item.comment || '',
			attributes: resolved[i],
		}));
		return {
			cloud,
			batch: Boolean(input.batch),
			worker,
			issues: Object.fromEntries(Object.values(issues).map((i) => [i.key, i])),
			names,
			logs,
		};
	},
	summary: (p) => (p.batch
		? `Log ${p.logs.length} Tempo worklogs (${hours(total(p.logs))}h) ${dateRange(p.logs)}`
		: `Log ${hours(p.logs[0].seconds)}h in Tempo on ${p.logs[0].issueKey} ${dateRange(p.logs)}`),
	details: (p) => (p.batch ? batchDetails(p) : singleDetails(p)),
	// A batch posts its rows in order and goes on after a failed row, so one rejected row does not stop
	// the rest; a single worklog fails as a whole, which keeps a refused one pending on approval.
	async run(connection, p) {
		const { client } = await tempo(connection);
		if (!p.batch) return [{ ok: true, id: (await client.createWorklog(connection, p.logs[0])).id }];
		const results = [];
		for (const log of p.logs) {
			try {
				results.push({ ok: true, id: (await client.createWorklog(connection, log)).id });
			} catch (err) {
				results.push({ ok: false, error: failureReason(err) });
			}
		}
		return results;
	},
	report(results, p) {
		const rows = p.logs.map((log, i) => ({
			date: log.date,
			key: log.issueKey,
			hours: Number(hours(log.seconds)),
			...results[i],
		}));
		if (!p.batch) {
			const log = p.logs[0];
			return {
				message: `Logged ${hours(log.seconds)}h in Tempo on ${log.issueKey} on ${log.date} (worklog ${rows[0].id})`,
				json: { worklogs: rows },
			};
		}
		const failed = rows.filter((r) => !r.ok);
		const lines = rows.map((r) => `${r.date} ${r.key} ${r.hours} -> ${r.ok ? `ok ${r.id}` : `FAILED ${r.error}`}`);
		const sent = rows.length - failed.length;
		const heading = failed.length
			? `Logged ${sent} of ${rows.length} Tempo worklogs; ${failed.length} failed`
			: `Logged ${rows.length} Tempo worklogs (${hours(total(p.logs))}h)`;
		return { message: [heading, ...lines].join('\n'), json: { worklogs: rows }, failed: failed.length > 0 };
	},
};

// The fields an edit compares and changes.
function snapshot(log, cloud) {
	return JSON.stringify([log.date, log.start, log.seconds, cloud ? log.billableSeconds : null, log.comment, log.attributes]);
}

function stale(id) {
	const err = new Error(`Tempo worklog ${id} changed after the preview. Reject this action and request it again.`);
	err.stale = true;
	return err;
}

function change(label, before, after) {
	return before === after ? [] : [[label, `${before === '' ? '(none)' : before} → ${after === '' ? '(none)' : after}`]];
}

// `input` is { id, hours, comment, workType, date, start, billableHours }; the options left out keep
// their current values. Tempo replaces the worklog with what is sent, so the current worklog is read
// and merged here, and approval checks that it has not changed since.
export const worklogEdit = {
	name: 'tempo.worklog.edit',
	type: JIRA_TYPES,
	async prepare(connection, input) {
		const given = ['hours', 'comment', 'workType', 'date', 'start', 'billableHours'].filter((k) => input[k] !== undefined);
		if (!given.length) throw new Error('Nothing to change. Pass at least one of --hours, --comment, --work-type, --date, --start, --billable-hours.');
		const { cloud, client } = await tempo(connection);
		if (input.billableHours !== undefined && !cloud) throw new Error('Jira Server/Data Center Tempo ignores billable hours; leave out --billable-hours.');
		const before = await client.getWorklog(connection, input.id);
		const seconds = input.hours !== undefined ? parseHours(input.hours, '--hours') : before.seconds;
		const after = {
			...before,
			date: input.date !== undefined ? requireDate(input.date, '--date') : before.date,
			start: input.start !== undefined ? requireStart(input.start, '--start') : before.start || DEFAULT_START,
			seconds,
			comment: input.comment !== undefined ? input.comment : before.comment,
		};
		if (cloud) {
			const billable = input.billableHours !== undefined ? parseHours(input.billableHours, '--billable-hours', { allowZero: true }) : undefined;
			if (billable > seconds) throw new Error(`Billable hours ${hours(billable)} are more than the ${hours(seconds)} hours logged.`);
			// A fully billable worklog stays fully billable when its hours change.
			const current = before.billableSeconds ?? before.seconds;
			after.billableSeconds = billable ?? (current >= before.seconds ? seconds : Math.min(current, seconds));
		}
		let names = {};
		if (input.workType !== undefined) {
			const resolved = await resolveAttributes(connection, client, [{ workType: input.workType }]);
			names = resolved.names;
			after.attributes = { ...before.attributes, ...resolved.resolved[0] };
		}
		return { id: String(input.id), cloud, before, after, names };
	},
	async verify(connection, p) {
		const { client } = await tempo(connection);
		const now = await client.getWorklog(connection, p.id);
		if (snapshot(now, p.cloud) !== snapshot(p.before, p.cloud)) throw stale(p.id);
	},
	summary: (p) => `Edit Tempo worklog ${p.id} on ${p.before.issueKey || `issue ${p.before.issueId}`}`,
	details: (p) => {
		const { before, after } = p;
		const changes = [
			...change('Date', before.date, after.date),
			...change('Start', before.start, after.start),
			...change('Hours', hours(before.seconds), hours(after.seconds)),
			...(p.cloud ? change('Billable hours', hours(before.billableSeconds ?? before.seconds), hours(after.billableSeconds)) : []),
			...change('Comment', before.comment, after.comment),
			...ATTRIBUTES.flatMap((a) => change(attributeTitle(p.names, a.key), attributeText(p.names, a.key, before.attributes[a.key] ?? ''), attributeText(p.names, a.key, after.attributes[a.key] ?? ''))),
		];
		return [
			['Worklog', `${p.id} on ${before.issueKey || before.issueId}, ${before.date} ${hours(before.seconds)}h`],
			...(changes.length ? changes : [['Changes', 'none; the worklog already has these values']]),
		];
	},
	run: async (connection, p) => (await tempo(connection)).client.updateWorklog(connection, p.id, p.after),
	report: (_, p) => ({
		message: `Updated Tempo worklog ${p.id}`,
		json: { id: p.id, key: p.after.issueKey, date: p.after.date, hours: Number(hours(p.after.seconds)) },
	}),
};

export const worklogDelete = {
	name: 'tempo.worklog.delete',
	type: JIRA_TYPES,
	prepare: async (connection, input) => ({ id: String(input.id) }),
	async preview(connection, p) {
		return { log: await (await tempo(connection)).client.getWorklog(connection, p.id) };
	},
	summary: (p) => `Delete Tempo worklog ${p.id}${p.log ? ` on ${p.log.issueKey || `issue ${p.log.issueId}`}` : ''}`,
	details: (p) => (p.log
		? [
			['Issue', p.log.issueKey || p.log.issueId],
			['Date', p.log.date],
			['Start', p.log.start],
			['Hours', hours(p.log.seconds)],
			['Comment', p.log.comment || '(none)'],
			...Object.entries(p.log.attributes).map(([key, value]) => [attributeTitle(null, key), String(value)]),
		]
		: [['Worklog', p.id]]),
	run: async (connection, p) => (await tempo(connection)).client.deleteWorklog(connection, p.id),
	report: (_, p) => ({ message: `Deleted Tempo worklog ${p.id}`, json: { id: p.id } }),
};
