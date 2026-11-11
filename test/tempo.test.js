import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import store from './helpers/config.js';
import { worklogAdd, worklogEdit, parseHours } from '../src/actions/tempo.js';
import { searchWorklogs } from '../src/clients/tempoCloud.js';
import { readPlan, parseCsv } from '../src/utils/worklogPlan.js';
import { READ_ONLY_POST } from '../src/commands/api.js';

const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));
const files = mkdtempSync(join(tmpdir(), 'devtool-tempo-'));

function dev(...args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, NO_COLOR: '1' } });
		let output = '';
		child.stdout.on('data', (chunk) => { output += chunk; });
		child.stderr.on('data', (chunk) => { output += chunk; });
		child.on('close', (status) => resolve({ status, output }));
	});
}

let server;
let baseUrl;
let requests;
let worklogs;

const ATTRIBUTES = [
	{ id: 1, key: '_WorkType_', name: 'Work Type', type: { name: 'Static List', value: 'STATIC_LIST' }, required: true, staticListValues: [
		{ value: 'WT025', name: 'Development', removed: false },
		{ value: 'WT005', name: 'Meetings', removed: false },
		{ value: 'WT999', name: 'Old', removed: true },
	] },
	{ id: 2, key: '_WageType_', name: 'Wage Type', type: { value: 'STATIC_LIST' }, required: false, staticListValues: [{ value: 'W001', name: 'Normal', removed: false }] },
	{ id: 3, key: '_PricingMultiplier_', name: 'Pricing Multiplier', type: { value: 'STATIC_LIST' }, required: false, staticListValues: [{ value: 'PM001', name: '1.0', removed: false }] },
];

const ISSUES = {
	'SQTDEV-12822': { id: '1001', key: 'SQTDEV-12822', fields: { summary: 'Login fix', status: { name: 'In Progress' } } },
	'SQTDEV-5': { id: '1005', key: 'SQTDEV-5', fields: { summary: 'Meetings', status: { name: 'Open' } } },
};

function serverWorklog(id, body) {
	return {
		tempoWorklogId: id,
		originTaskId: 1001,
		issue: { id: 1001, key: body.originTaskId || 'SQTDEV-12822' },
		started: body.started,
		timeSpentSeconds: body.timeSpentSeconds,
		billableSeconds: 0,
		comment: body.comment,
		worker: 'JIRAUSER38404',
		attributes: Object.fromEntries(Object.entries(body.attributes || {}).map(([key, a]) => [key, { key, value: a.value, name: key }])),
	};
}

// A Jira Server site with the Tempo Timesheets plugin.
function respond({ method, path, body }) {
	const url = new URL(path, baseUrl);
	if (url.pathname === '/rest/api/2/myself') return [200, { key: 'JIRAUSER38404', name: 'me', displayName: 'Me Myself' }];
	const issue = /^\/rest\/api\/2\/issue\/([^/]+)$/.exec(url.pathname);
	if (issue) return ISSUES[issue[1]] ? [200, ISSUES[issue[1]]] : [404, { errorMessages: ['Issue Does Not Exist'] }];
	if (url.pathname === '/rest/tempo-core/1/work-attribute') return [200, ATTRIBUTES];
	if (url.pathname === '/rest/tempo-timesheets/4/worklogs/search') return [200, Object.values(worklogs)];
	if (url.pathname === '/rest/tempo-timesheets/4/worklogs' && method === 'POST') {
		if (body.comment === 'reject me') return [400, { errors: { comment: 'Tempo refused this one' } }];
		// The current request is already recorded, so the first worklog is 200.
		const id = 199 + requests.filter((r) => r.method === 'POST' && r.path === '/rest/tempo-timesheets/4/worklogs').length;
		worklogs[id] = serverWorklog(id, body);
		return [200, [worklogs[id]]];
	}
	const one = /^\/rest\/tempo-timesheets\/4\/worklogs\/(\d+)$/.exec(url.pathname);
	if (one) {
		if (!worklogs[one[1]]) return [404, { errorMessages: ['Not found'] }];
		if (method === 'DELETE') return [204];
		if (method === 'PUT') return [200, serverWorklog(Number(one[1]), body)];
		return [200, worklogs[one[1]]];
	}
	return [500, { errorMessages: [`Unexpected ${method} ${path}`] }];
}

before(async () => {
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => { raw += chunk; });
		req.on('end', () => {
			const entry = { method: req.method, path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined };
			requests.push(entry);
			const [status, data] = respond(entry);
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(data === undefined ? '' : JSON.stringify(data));
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
	server.close();
	rmSync(files, { recursive: true, force: true });
});

beforeEach(() => {
	requests = [];
	worklogs = {};
	store.default.set('connections', []);
	rmSync(join(store.configDirectory(), 'pending'), { recursive: true, force: true });
});

function jira(settings = {}) {
	store.saveConnection({ type: 'jira', baseUrl, token: 'jira-token', allowWrite: true, tempoWageType: 'W001', tempoPricing: 'PM001', ...settings });
}

const tempoWrites = () => requests.filter((r) => r.method !== 'GET' && !r.path.endsWith('/search'));

test('a Server worklog is checked, held with its defaults, and posted as Tempo expects on approval', async () => {
	// Setup saves a skipped start prompt as empty, which must leave the 09:00 default in place.
	jira({ tempoStart: '' });
	assert.equal(store.listConnections()[0].tempoStart, undefined);
	const held = await dev('tempo', 'worklog', 'add', 'SQTDEV-12822', '--date', '2026-11-02', '--hours', '0,75', '-m', 'Korjaus', '--work-type', 'development', '--json');
	assert.equal(held.status, 2, held.output);
	const pending = JSON.parse(held.output);
	assert.equal(pending.summary, 'Log 0.75h in Tempo on SQTDEV-12822 on 2026-11-02');
	assert.equal(pending.details.Issue, 'SQTDEV-12822 (Login fix, In Progress)');
	assert.equal(pending.details['Work Type'], 'WT025 (Development)');
	assert.equal(pending.details['Wage Type'], 'W001 (Normal)');
	assert.equal(pending.details.Worker, 'Me Myself (JIRAUSER38404)');
	assert.equal(pending.details['Billable hours'], undefined);
	assert.deepEqual(tempoWrites(), []);
	assert.ok(requests.some((r) => r.path === '/rest/api/2/issue/SQTDEV-12822?fields=summary%2Cstatus'));

	const approved = await dev('pending', 'approve', pending.id, '--plain');
	assert.equal(approved.status, 0, approved.output);
	assert.match(approved.output, /Logged 0\.75h in Tempo on SQTDEV-12822 on 2026-11-02 \(worklog 200\)/);
	assert.deepEqual(tempoWrites().map((r) => [r.method, r.path, r.auth, r.body]), [[
		'POST', '/rest/tempo-timesheets/4/worklogs', 'Bearer jira-token', {
			worker: 'JIRAUSER38404', originTaskId: 'SQTDEV-12822', started: '2026-11-02 09:00:00.000',
			timeSpentSeconds: 2700, comment: 'Korjaus', endDate: null, includeNonWorkingDays: false,
			attributes: { _WorkType_: { value: 'WT025' }, _WageType_: { value: 'W001' }, _PricingMultiplier_: { value: 'PM001' } },
		},
	]]);
});

test('a wrong key, attribute value, or Server billable hours fail before anything is held', async () => {
	jira({ tempoStart: '8:30' });
	assert.equal(store.listConnections()[0].tempoStart, '08:30');
	const missing = await dev('tempo', 'worklog', 'add', 'SQTDEV-404', '--date', '2026-11-02', '--hours', '1');
	assert.equal(missing.status, 1);
	assert.match(missing.output, /Issue\(s\) not found, or not visible to you: SQTDEV-404/);
	const removed = await dev('tempo', 'worklog', 'add', 'SQTDEV-12822', '--date', '2026-11-02', '--hours', '1', '--work-type', 'WT999');
	assert.match(removed.output, /"WT999" is not a Work Type \(--work-type\)\. Allowed: WT025 \(Development\), WT005 \(Meetings\)\./);
	const billable = await dev('tempo', 'worklog', 'add', 'SQTDEV-12822', '--date', '2026-11-02', '--hours', '1', '--billable-hours', '0');
	assert.match(billable.output, /ignores billable hours/);
	const date = await dev('tempo', 'worklog', 'add', 'SQTDEV-12822', '--date', '2026-02-30', '--hours', '1');
	assert.match(date.output, /--date "2026-02-30" is not a date/);
	assert.deepEqual(tempoWrites(), []);
	assert.equal((await dev('pending', 'list', '--json')).output.trim(), '[]');
});

test('a plan is checked whole, approved once, posted in order, and fails when a row fails', async () => {
	jira({ tempoStart: '08:30' });
	const plan = join(files, 'plan.csv');
	writeFileSync(plan, [
		'2026-11-02,SQTDEV-12822,1.5,"Fix, part 1",WT025',
		'2026-11-02,sqtdev-5,0.5,reject me,WT005',
		'2026-11-03,SQTDEV-12822,6,"Fix ""part 2""",',
	].join('\r\n'));
	const held = await dev('tempo', 'worklog', 'add', '--file', plan, '--work-type', 'WT005', '--json');
	assert.equal(held.status, 2, held.output);
	const pending = JSON.parse(held.output);
	assert.equal(pending.summary, 'Log 3 Tempo worklogs (8h) from 2026-11-02 to 2026-11-03');
	// One table, with each day's total under its rows; an empty worktype column takes the --work-type default.
	assert.equal(pending.details.Worklogs, [
		'Date        Issue         Hours  Start  Attributes        Comment',
		'2026-11-02  SQTDEV-12822  1.5h   08:30  WT025 W001 PM001  Fix, part 1',
		'2026-11-02  SQTDEV-5      0.5h   08:30  WT005 W001 PM001  reject me',
		'            Day total     2h',
		'2026-11-03  SQTDEV-12822  6h     08:30  WT005 W001 PM001  Fix "part 2"',
		'            Day total     6h',
	].join('\n'));
	assert.equal(pending.details.Total, '8h in 3 worklogs');
	assert.match(pending.details.Issues, /SQTDEV-5 {6}Meetings, Open/);
	// The table is shown in full, however long the plan.
	assert.doesNotMatch((await dev('pending', 'show', pending.id, '--plain')).output, /more characters/);
	assert.deepEqual(tempoWrites(), []);

	const approved = await dev('pending', 'approve', pending.id, '--plain');
	assert.equal(approved.status, 1, approved.output);
	assert.match(approved.output, /Logged 2 of 3 Tempo worklogs; 1 failed/);
	assert.match(approved.output, /2026-11-02 SQTDEV-12822 1\.5 -> ok 200\n2026-11-02 SQTDEV-5 0\.5 -> FAILED comment: Tempo refused this one\n2026-11-03 SQTDEV-12822 6 -> ok 202/);
	assert.deepEqual(tempoWrites().map((r) => [r.body.originTaskId, r.body.started, r.body.timeSpentSeconds]), [
		['SQTDEV-12822', '2026-11-02 08:30:00.000', 5400],
		['SQTDEV-5', '2026-11-02 08:30:00.000', 1800],
		['SQTDEV-12822', '2026-11-03 08:30:00.000', 21600],
	]);
	// The sent rows cannot be approved a second time.
	assert.match((await dev('pending', 'approve', pending.id)).output, /No pending action/);
});

test('a plan with one bad row or key holds nothing', async () => {
	jira();
	const plan = join(files, 'bad.json');
	writeFileSync(plan, JSON.stringify([
		{ date: '2026-11-02', key: 'SQTDEV-12822', hours: 1 },
		{ date: '2026-11-02', key: 'SQTDEV-12822', hours: 'lots' },
	]));
	assert.match((await dev('tempo', 'worklog', 'add', '--file', plan)).output, /Row 2: Hours "lots" is not a number of hours/);
	writeFileSync(plan, JSON.stringify([{ date: '2026-11-02', key: 'SQTDEV-404', hours: 1 }, { date: '2026-11-02', key: 'NOPE-1', hours: 1 }]));
	assert.match((await dev('tempo', 'worklog', 'add', '--file', plan)).output, /not found, or not visible to you: SQTDEV-404, NOPE-1/);
	assert.match((await dev('tempo', 'worklog', 'add', 'SQTDEV-1', '--file', plan)).output, /leave out the issue key/);
	assert.deepEqual(tempoWrites(), []);
});

test('the worklog list shows each worklog and the total of each day', async () => {
	jira();
	worklogs = {
		7: serverWorklog(7, { started: '2026-11-03 09:00:00.000', timeSpentSeconds: 3600, comment: 'B', attributes: { _WorkType_: { value: 'WT005' } } }),
		6: serverWorklog(6, { started: '2026-11-02 09:00:00.000', timeSpentSeconds: 2700, comment: 'A', attributes: { _WorkType_: { value: 'WT025' } } }),
		8: serverWorklog(8, { started: '2026-11-02 10:00:00.000', timeSpentSeconds: 5400, comment: 'C' }),
	};
	const plain = await dev('tempo', 'worklog', 'list', '--from', '2026-11-02', '--to', '2026-11-06', '--plain');
	assert.equal(plain.status, 0, plain.output);
	assert.equal(plain.output, [
		'6 2026-11-02 SQTDEV-12822 0.75 WT025 A',
		'8 2026-11-02 SQTDEV-12822 1.5 - C',
		'7 2026-11-03 SQTDEV-12822 1 WT005 B',
		'2026-11-02 total 2.25',
		'2026-11-03 total 1',
		'total 3.25',
		'',
	].join('\n'));
	const search = requests.find((r) => r.path.endsWith('/search'));
	assert.deepEqual(search.body, { from: '2026-11-02', to: '2026-11-06', worker: ['JIRAUSER38404'] });

	const json = JSON.parse((await dev('tempo', 'worklog', 'list', '--from', '2026-11-02', '--worker', 'JIRAUSER1', '--json')).output);
	assert.deepEqual(requests.at(-1).body, { from: '2026-11-02', to: '2026-11-02', worker: ['JIRAUSER1'] });
	assert.deepEqual(json.days, [{ date: '2026-11-02', hours: 2.25, seconds: 8100 }, { date: '2026-11-03', hours: 1, seconds: 3600 }]);
	assert.equal(json.worklogs[0].workType, 'WT025');
	// Server Tempo answers billableSeconds 0 for every worklog; it is not reported.
	assert.equal('billableHours' in json.worklogs[0], false);
});

test('an edit sends the current worklog with the changed fields, and refuses if it changed meanwhile', async () => {
	jira();
	worklogs[55] = serverWorklog(55, { started: '2026-11-02 09:00:00.000', timeSpentSeconds: 2700, comment: 'Korjaus', attributes: { _WorkType_: { value: 'WT025' }, _WageType_: { value: 'W001' } } });
	const held = JSON.parse((await dev('tempo', 'worklog', 'edit', '55', '--hours', '1.5', '--work-type', 'WT005', '--json')).output);
	assert.equal(held.summary, 'Edit Tempo worklog 55 on SQTDEV-12822');
	assert.deepEqual(held.details, {
		Worklog: '55 on SQTDEV-12822, 2026-11-02 0.75h',
		Hours: '0.75 → 1.5',
		'Work Type': 'WT025 → WT005 (Meetings)',
	});
	const approved = await dev('pending', 'approve', held.id);
	assert.equal(approved.status, 0, approved.output);
	assert.deepEqual(tempoWrites().map((r) => [r.method, r.path, r.body]), [[
		'PUT', '/rest/tempo-timesheets/4/worklogs/55', {
			started: '2026-11-02 09:00:00.000', timeSpentSeconds: 5400, comment: 'Korjaus',
			attributes: { _WorkType_: { value: 'WT005' }, _WageType_: { value: 'W001' } },
		},
	]]);

	const again = JSON.parse((await dev('tempo', 'worklog', 'edit', '55', '--comment', 'New', '--json')).output);
	worklogs[55].comment = 'Changed in the browser';
	const refused = await dev('pending', 'approve', again.id);
	assert.equal(refused.status, 1);
	assert.match(refused.output, /changed after the preview/);
	assert.equal(tempoWrites().length, 1);
	assert.match((await dev('tempo', 'worklog', 'edit', '55')).output, /Nothing to change/);
});

test('a delete previews the worklog and sends DELETE on approval', async () => {
	jira();
	worklogs[56] = serverWorklog(56, { started: '2026-11-04 09:00:00.000', timeSpentSeconds: 3600, comment: 'Gone' });
	const held = JSON.parse((await dev('tempo', 'worklog', 'delete', '56', '--json')).output);
	assert.equal(held.summary, 'Delete Tempo worklog 56 on SQTDEV-12822');
	assert.equal(held.details.Comment, 'Gone');
	assert.equal((await dev('pending', 'approve', held.id)).status, 0);
	assert.deepEqual(tempoWrites().map((r) => [r.method, r.path]), [['DELETE', '/rest/tempo-timesheets/4/worklogs/56']]);
});

test('Tempo writes follow allowWrite like every other write', async () => {
	jira({ allowWrite: false });
	const refused = await dev('tempo', 'worklog', 'delete', '56', '--approve');
	assert.equal(refused.status, 1);
	assert.match(refused.output, /Writes are disabled/);
	assert.deepEqual(requests, []);
});

test('attributes lists the allowed values of each work attribute', async () => {
	jira();
	const plain = await dev('tempo', 'attributes', '--plain');
	assert.match(plain.output, /^_WorkType_ Work Type \(STATIC_LIST, required\)\n {2}WT025 Development\n {2}WT005 Meetings\n_WageType_/);
	assert.doesNotMatch(plain.output, /WT999/);
});

test('the Tempo search is a read-only POST endpoint of dev api', () => {
	assert.ok(READ_ONLY_POST.jira.includes('/rest/tempo-timesheets/4/worklogs/search'));
});

// --- Tempo Cloud ---

const cloud = {
	type: 'jira', name: 'cloud', baseUrl: 'https://x.atlassian.net', email: 'e@example.invalid', token: 'atlassian', tempoToken: 'tempo-secret', allowWrite: true,
};

function cloudFetch(t, handle) {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		const call = { url: new URL(url), method: options.method, auth: options.headers.Authorization, body: options.body && JSON.parse(options.body) };
		calls.push(call);
		const [status, data] = handle(call);
		return new Response(data === undefined ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
	});
	return calls;
}

const cloudJira = ({ url }) => {
	if (url.pathname === '/rest/api/3/myself') return [200, { accountId: 'acc-1', displayName: 'Me' }];
	if (url.pathname === '/rest/api/3/issue/SQTUKI-7') return [200, { id: '10007', key: 'SQTUKI-7', fields: { summary: 'Cloud issue', status: { name: 'Open' } } }];
	return undefined;
};

test('a Tempo Cloud worklog takes the numeric issue ID, the account ID, and billable seconds', async (t) => {
	const calls = cloudFetch(t, (call) => cloudJira(call)
		?? (call.url.pathname === '/4/work-attributes' ? [200, { metadata: {}, results: [{ key: '_WorkType_', name: 'Work Type', type: 'STATIC_LIST', values: ['a1b2'], names: { a1b2: 'Development' } }] }] : undefined)
		?? [200, { tempoWorklogId: 900, issue: { id: 10007 }, timeSpentSeconds: 7200, billableSeconds: 1800, startDate: '2026-11-02', startTime: '09:00:00' }]);
	const params = await worklogAdd.prepare(cloud, { batch: false, rows: [{ key: 'SQTUKI-7', date: '2026-11-02', hours: '2', billableHours: '0.5', workType: 'Development', comment: 'Review' }] });
	assert.deepEqual(worklogAdd.details(params).find(([name]) => name === 'Billable hours'), ['Billable hours', '0.5']);
	const result = await worklogAdd.run(cloud, params);
	assert.deepEqual(result, [{ ok: true, id: '900' }]);
	const post = calls.at(-1);
	assert.equal(post.url.toString(), 'https://api.tempo.io/4/worklogs');
	assert.equal(post.auth, 'Bearer tempo-secret');
	assert.deepEqual(post.body, {
		authorAccountId: 'acc-1', startDate: '2026-11-02', startTime: '09:00:00', timeSpentSeconds: 7200, billableSeconds: 1800,
		description: 'Review', attributes: [{ key: '_WorkType_', value: 'a1b2' }], issueId: 10007,
	});
	// Jira lookups use the Atlassian credentials; only api.tempo.io gets the Tempo token.
	assert.ok(calls.filter((c) => c.url.hostname === 'x.atlassian.net').every((c) => c.auth.startsWith('Basic ')));

	await assert.rejects(worklogAdd.prepare(cloud, { batch: false, rows: [{ key: 'SQTUKI-7', date: '2026-11-02', hours: '1', billableHours: '2' }] }), /Billable hours 2 are more than the 1 hours logged/);
	const full = await worklogAdd.prepare(cloud, { batch: false, rows: [{ key: 'SQTUKI-7', date: '2026-11-02', hours: '1' }] });
	assert.equal(full.logs[0].billableSeconds, 3600);
});

test('Tempo Cloud worklogs are listed across pages with their issue keys from Jira', async (t) => {
	const calls = cloudFetch(t, ({ url }) => {
		if (url.pathname === '/rest/api/3/search/jql') return [200, { issues: [{ id: '10007', key: 'SQTUKI-7' }], isLast: true }];
		if (url.searchParams.get('offset') === '1') return [200, { metadata: {}, results: [{ tempoWorklogId: 2, issue: { id: 10007 }, timeSpentSeconds: 60, billableSeconds: 0, startDate: '2026-11-03', startTime: '9:15:00', attributes: { values: [] } }] }];
		return [200, { metadata: { next: 'https://api.tempo.io/4/worklogs/user/acc-1?offset=1' }, results: [{ tempoWorklogId: 1, issue: { id: 10007 }, timeSpentSeconds: 3600, billableSeconds: 3600, startDate: '2026-11-02', startTime: '09:00:00', description: 'D', attributes: { values: [{ key: '_WorkType_', value: 'a1b2' }] } }] }];
	});
	const list = await searchWorklogs(cloud, { from: '2026-11-02', to: '2026-11-03', worker: 'acc-1' });
	assert.deepEqual(list.map((w) => [w.id, w.issueKey, w.date, w.start, w.seconds, w.billableSeconds, w.attributes]), [
		['1', 'SQTUKI-7', '2026-11-02', '09:00', 3600, 3600, { _WorkType_: 'a1b2' }],
		['2', 'SQTUKI-7', '2026-11-03', '09:15', 60, 0, {}],
	]);
	assert.equal(calls[0].url.toString(), 'https://api.tempo.io/4/worklogs/user/acc-1?from=2026-11-02&to=2026-11-03&limit=1000');
	assert.equal(calls.at(-1).url.searchParams.get('jql'), 'id in (10007)');
});

test('a Tempo Cloud edit sends the whole worklog, and full billing follows changed hours', async (t) => {
	const calls = cloudFetch(t, ({ url, method, body }) => {
		if (url.pathname === '/rest/api/3/search/jql') return [200, { issues: [{ id: '10007', key: 'SQTUKI-7' }], isLast: true }];
		if (method === 'PUT') return [200, { tempoWorklogId: 5, issue: { id: 10007 }, ...body, attributes: { values: body.attributes } }];
		return [200, { tempoWorklogId: 5, issue: { id: 10007 }, author: { accountId: 'acc-1' }, timeSpentSeconds: 3600, billableSeconds: 3600, startDate: '2026-11-02', startTime: '13:00:00', description: 'D', attributes: { values: [{ key: '_WageType_', value: 'W' }] } }];
	});
	const params = await worklogEdit.prepare(cloud, { id: '5', hours: '2' });
	await worklogEdit.run(cloud, params);
	assert.deepEqual(calls.at(-1).body, {
		authorAccountId: 'acc-1', startDate: '2026-11-02', startTime: '13:00:00', timeSpentSeconds: 7200, billableSeconds: 7200,
		description: 'D', attributes: [{ key: '_WageType_', value: 'W' }],
	});
});

test('Tempo Cloud without a Tempo token says how to store one', async (t) => {
	cloudFetch(t, (call) => cloudJira(call) ?? [500]);
	const { tempoToken, ...noToken } = cloud;
	await assert.rejects(worklogAdd.prepare(noToken, { batch: false, rows: [{ key: 'SQTUKI-7', date: '2026-11-02', hours: '1', workType: 'x' }] }), /dev config token cloud --field tempoToken/);
	assert.throws(() => store.setField('jira', 'tempoApiUrl', 'https://evil.example.invalid'), /Enter one of https:\/\/api\.tempo\.io/);
});

test('a stored Tempo token fills the connection like the main token', () => {
	store.saveConnection({ type: 'jira', name: 'cloud', baseUrl: 'https://x.atlassian.net', email: 'e', token: 't' });
	assert.equal(store.getConnection('jira', 'cloud').tempoToken, undefined);
	store.storeSecret('cloud', 'tempoToken', 'tempo-secret');
	assert.equal(store.getConnection('jira', 'cloud').tempoToken, 'tempo-secret');
});

// --- Plans and hours ---

test('plans read CSV with or without a header, with ";" from Excel, or JSON', () => {
	const semicolon = join(files, 'excel.csv');
	writeFileSync(semicolon, '﻿Date;Key;Hours;Comment;Work Type;Start\r\n2026-11-02;SQTDEV-1;1,5;"a; b";WT025;10:00\r\n\r\n');
	assert.deepEqual(readPlan(semicolon), [{ date: '2026-11-02', key: 'SQTDEV-1', hours: '1,5', comment: 'a; b', workType: 'WT025', start: '10:00' }]);
	const json = join(files, 'plan.json');
	writeFileSync(json, JSON.stringify([{ date: '2026-11-02', key: 'SQTDEV-1', hours: 2, workType: 'WT005', billableHours: 0 }]));
	assert.deepEqual(readPlan(json), [{ date: '2026-11-02', key: 'SQTDEV-1', hours: '2', workType: 'WT005', billableHours: '0' }]);
	writeFileSync(json, JSON.stringify([{ day: '2026-11-02' }]));
	assert.throws(() => readPlan(json), /Unknown field "day"/);
	assert.deepEqual(parseCsv('a,"multi\nline"\n'), [['a', 'multi\nline']]);
	assert.throws(() => parseCsv('a,"open'), /without its closing quote/);
	const wide = join(files, 'wide.csv');
	writeFileSync(wide, '2026-11-02,SQTDEV-1,1,a,b,WT025\n');
	assert.throws(() => readPlan(wide), /Row 1 has 6 columns/);
});

test('hours are decimal, positive, and at most a day', () => {
	assert.equal(parseHours('0.75', 'h'), 2700);
	assert.equal(parseHours('1,5', 'h'), 5400);
	assert.equal(parseHours('0', 'h', { allowZero: true }), 0);
	assert.throws(() => parseHours('0', '--hours'), /more than 0/);
	assert.throws(() => parseHours('25', '--hours'), /more than 24 hours/);
	assert.throws(() => parseHours('1h', '--hours'), /not a number of hours/);
});
