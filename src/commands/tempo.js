import { Command } from 'commander';
import { JIRA_TYPES } from '../clients/jira.js';
import { tempo } from '../clients/tempo.js';
import { worklogAdd, worklogEdit, worklogDelete, requireDate, DEFAULT_START } from '../actions/tempo.js';
import { label } from '../config/store.js';
import { formatWorklogs, plainWorklogs, curateWorklogsJson, formatAttributes, plainAttributes } from '../formatters/tempo.js';
import { readPlan } from '../utils/worklogPlan.js';
import { connectionFor, projectOf } from '../utils/connection.js';
import { runWrite } from '../utils/write.js';
import { spinner } from '../utils/output.js';
import { handleError } from '../utils/errors.js';
import { getOutputMode, outputJson } from '../utils/mode.js';

// `dev tempo` logs time in Tempo Timesheets on the site of a `jira` or `serviceDesk` connection: through
// the Timesheets plugin on Jira Server/Data Center, and through api.tempo.io on Jira Cloud.

function today() {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function read(cmd, { busy, failed, context, fetch, json, plain, rich, done }) {
	const mode = getOutputMode(cmd);
	const s = mode === 'rich' ? spinner(busy).start() : null;
	return (async () => {
		try {
			const result = await fetch(connectionFor(cmd, JIRA_TYPES));
			if (s) s.success({ text: done(result) });
			if (mode === 'json') outputJson(json(result));
			else if (mode === 'plain') plain(result);
			else rich(result);
		} catch (err) {
			if (s) s.error({ text: failed });
			handleError(err, err.url || context);
		}
	})();
}

// A batch is one approval on one site, so its keys must not route to different connections.
function assertOneConnection(cmd, rows) {
	if (cmd.optsWithGlobals().connection) return;
	const projects = [...new Set(rows.map((row) => projectOf(row.key)).filter(Boolean))];
	const labels = new Map();
	for (const project of projects) labels.set(project, label(connectionFor(cmd, JIRA_TYPES, project)));
	if (new Set(labels.values()).size > 1) {
		const where = [...labels.entries()].map(([project, name]) => `${project} → ${name}`).join(', ');
		throw new Error(`The plan has issues on more than one connection (${where}). Split it per connection, or pass --connection.`);
	}
}

const ROW_DEFAULTS = ['workType', 'wageType', 'pricing', 'start', 'billableHours'];

function addInput(cmd, key, opts) {
	if (opts.file) {
		const given = [key && 'the issue key', opts.date && '--date', opts.hours && '--hours', opts.comment !== undefined && '--comment'].filter(Boolean);
		if (given.length) throw new Error(`--file reads the date, key, hours, and comment of each worklog from the file; leave out ${given.join(', ')}.`);
		// The other options fill the columns a row leaves empty.
		const defaults = Object.fromEntries(ROW_DEFAULTS.filter((k) => opts[k] !== undefined).map((k) => [k, opts[k]]));
		const rows = readPlan(opts.file).map((row) => ({ ...defaults, ...row }));
		assertOneConnection(cmd, rows);
		return { batch: true, rows };
	}
	if (!key) throw new Error('Give an issue key, or a plan with --file <path>.');
	if (!opts.date) throw new Error('A date is required. Pass --date YYYY-MM-DD.');
	if (!opts.hours) throw new Error('The hours are required. Pass --hours <n>, e.g. --hours 0.75.');
	return {
		batch: false,
		rows: [{
			key, date: opts.date, hours: opts.hours, comment: opts.comment,
			...Object.fromEntries(ROW_DEFAULTS.map((k) => [k, opts[k]])),
		}],
	};
}

const tempoCmd = new Command('tempo')
	.description('Tempo Timesheets worklogs, on Jira Server/Data Center or Jira Cloud')
	.addHelpText('after', `
The connection is a jira or serviceDesk connection, picked as in dev jira: --connection, the project of
the issue key, or the default. Jira Server/Data Center uses the connection's own token. Jira Cloud needs
a Tempo API token (Tempo > Settings > API integration):
  dev config token <connection> --field tempoToken
and, outside the default host, the API host of the data region:
  dev config set <connection>.tempoApiUrl https://api.eu.tempo.io

Defaults of dev tempo worklog add, per connection:
  dev config set <connection>.tempoStart 09:00       (built-in default ${DEFAULT_START})
  dev config set <connection>.tempoWageType W001
  dev config set <connection>.tempoPricing PM001`);

const worklog = tempoCmd.command('worklog')
	.alias('worklogs')
	.description('List, log, edit, or delete Tempo worklogs');

worklog.command('list')
	.alias('ls')
	.description('List the worklogs of a period, with the total of each day')
	.option('--from <date>', 'First day, YYYY-MM-DD (default: today)')
	.option('--to <date>', 'Last day, YYYY-MM-DD (default: the --from day)')
	.option('--worker <id>', 'Whose worklogs: user key on Server (e.g. JIRAUSER38404), account ID on Cloud (default: you)')
	.action(function (opts) {
		return read(this, {
			busy: 'Fetching Tempo worklogs...', failed: 'Failed to fetch Tempo worklogs', context: 'tempo worklog list',
			fetch: async (connection) => {
				const from = requireDate(opts.from ?? today(), '--from');
				const to = requireDate(opts.to ?? from, '--to');
				if (to < from) throw new Error(`--to ${to} is before --from ${from}.`);
				const { client } = await tempo(connection);
				const worker = opts.worker || (await client.currentWorker(connection)).id;
				const worklogs = (await client.searchWorklogs(connection, { from, to, worker }))
					.sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
				return { from, to, worker, worklogs };
			},
			done: (r) => `${r.worklogs.length} worklog(s) from ${r.from} to ${r.to}`,
			json: curateWorklogsJson, plain: plainWorklogs, rich: formatWorklogs,
		});
	});

worklog.command('add [issueKey]')
	.description('Log work in Tempo, one worklog or a plan file (CSV or JSON) in one approval')
	.option('--date <date>', 'Day of the work, YYYY-MM-DD')
	.option('--hours <n>', 'Hours, e.g. 0.75')
	.option('-m, --comment <text>', 'Work description')
	.option('--work-type <code>', 'Work Type value, e.g. WT025 (`dev tempo attributes` lists them)')
	.option('--wage-type <code>', 'Wage Type value (default: tempoWageType of the connection)')
	.option('--pricing <code>', 'Pricing Multiplier value (default: tempoPricing of the connection)')
	.option('--start <HH:MM>', `Start time (default: tempoStart of the connection, else ${DEFAULT_START})`)
	.option('--billable-hours <n>', 'Jira Cloud: billable hours; 0 is non-billable, less than --hours bills part (default: all)')
	.option('-f, --file <path>', 'A plan: .csv with columns date,key,hours,comment,worktype, or .json; the options above fill empty columns')
	.addHelpText('after', `
Examples:
  dev tempo worklog add SQTDEV-12822 --date 2026-11-02 --hours 0.75 -m Korjaus --work-type WT025
  dev tempo worklog add --file plan.csv

A CSV plan without a header row has the columns date,key,hours,comment,worktype. A header row may name
these columns in any order, and also start, wagetype, pricing, and billable. A JSON plan is an array of
objects with the same names. Every issue key is checked first; then the whole plan is one approval.
The rows are posted in order, and a failed row does not stop the others; the command fails if any did.`)
	.action(async function (key, opts) {
		await runWrite(this, worklogAdd, () => addInput(this, key, opts));
	});

worklog.command('edit <worklogId>')
	.description('Change a Tempo worklog; the options left out keep their values')
	.option('--hours <n>', 'Hours, e.g. 1.5')
	.option('-m, --comment <text>', 'Work description')
	.option('--work-type <code>', 'Work Type value')
	.option('--date <date>', 'Day of the work, YYYY-MM-DD')
	.option('--start <HH:MM>', 'Start time')
	.option('--billable-hours <n>', 'Jira Cloud: billable hours')
	.action(async function (id, opts) {
		await runWrite(this, worklogEdit, () => ({
			id, hours: opts.hours, comment: opts.comment, workType: opts.workType, date: opts.date, start: opts.start, billableHours: opts.billableHours,
		}));
	});

worklog.command('delete <worklogId>')
	.alias('rm')
	.description('Delete a Tempo worklog')
	.action(async function (id) {
		await runWrite(this, worklogDelete, () => ({ id }));
	});

tempoCmd.command('attributes')
	.alias('attrs')
	.description('List the work attributes and their allowed values, e.g. the Work Type codes')
	.action(function () {
		return read(this, {
			busy: 'Fetching Tempo work attributes...', failed: 'Failed to fetch Tempo work attributes', context: 'tempo attributes',
			fetch: async (connection) => (await tempo(connection)).client.getAttributes(connection),
			done: (a) => `${a.length} work attribute(s)`,
			json: (a) => a, plain: plainAttributes, rich: formatAttributes,
		});
	});

export default tempoCmd;
