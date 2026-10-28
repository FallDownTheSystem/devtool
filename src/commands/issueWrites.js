import { table, spinner } from '../utils/output.js';
import { handleError } from '../utils/errors.js';
import { getOutputMode, outputJson } from '../utils/mode.js';
import { connectionFor } from '../utils/connection.js';
import { runWrite, readText, collect, parseFieldArgs, FILE_HELP } from '../utils/write.js';
import { site } from '../clients/jira.js';
import * as actions from '../actions/jira.js';
import { richText } from '../utils/markup.js';

const USER_HELP = 'Assignee: user name on Jira Server/Data Center, account ID on Jira Cloud';

function issueOptions(command) {
	return command
		.option('-s, --summary <text>', 'Summary')
		.option('-d, --description <text>', 'Description')
		.option('--description-file <path>', 'Read the description from a file ("-" for standard input)')
		.option('--priority <name>', 'Priority name')
		.option('--labels <list>', 'Comma-separated labels; replaces the current labels')
		.option('--assignee <user>', USER_HELP)
		.option('--parent <key>', 'Parent issue key')
		.option('--field <field=value>', 'Set any field by ID or display name, e.g. Account=23533. The value is converted to the type the field expects; JSON ({...}, [...], "...") is sent unchanged (repeatable)', collect, []);
}

function issueInput(opts) {
	const input = { fields: parseFieldArgs(opts.field) };
	const description = readText(opts.description, opts.descriptionFile, '--description-file');
	if (opts.summary !== undefined) input.summary = opts.summary;
	if (description !== undefined) input.description = description;
	if (opts.priority !== undefined) input.priority = opts.priority;
	if (opts.labels !== undefined) input.labels = opts.labels.split(',').map((l) => l.trim()).filter(Boolean);
	if (opts.assignee !== undefined) input.assignee = opts.assignee;
	if (opts.unassign) {
		if (opts.assignee !== undefined) throw new Error('Give --assignee or --unassign, not both.');
		input.assignee = null;
	}
	if (opts.parent !== undefined) input.parent = opts.parent;
	return input;
}

// Adds the write commands of `dev jira` (and its alias `dev sd`); `types` are the connection types it uses.
export function addIssueWriteCommands(parent, { types }) {
	issueOptions(parent.command('create'))
		.description('Create an issue')
		.option('-p, --project <key>', 'Project key (overrides the default project)')
		.option('-t, --type <name>', 'Issue type (default: Task)')
		.action(async function (opts) {
			await runWrite(this, actions.create, () => ({ ...issueInput(opts), project: opts.project, issueType: opts.type }));
		});

	issueOptions(parent.command('edit <key>'))
		.description('Change fields of an issue; the approval preview shows the current value of each')
		.option('--unassign', 'Remove the assignee')
		.action(async function (key, opts) {
			await runWrite(this, actions.edit, () => ({ ...issueInput(opts), key }));
		});

	parent.command('delete <key>')
		.alias('rm')
		.description('Delete an issue')
		.option('--delete-subtasks', 'Also delete its subtasks (required when it has any)')
		.action(async function (key, opts) {
			await runWrite(this, actions.remove, () => ({ key, deleteSubtasks: Boolean(opts.deleteSubtasks) }));
		});

	parent.command('transitions <key>')
		.description('List the workflow transitions available now')
		.action(async function (key) {
			const mode = getOutputMode(this);
			const s = mode === 'rich' ? spinner(`Fetching transitions for ${key}...`).start() : null;
			try {
				const connection = connectionFor(this, types, key);
				const transitions = await (await site(connection)).client.getTransitions(connection, key);
				if (s) s.success({ text: `${transitions.length} transition(s)` });
				const rows = transitions.map((t) => ({ id: String(t.id), name: t.name, to: t.to?.name || null }));
				if (mode === 'json') outputJson(rows);
				else if (mode === 'plain') for (const t of rows) console.log(`${t.id} ${t.name} -> ${t.to}`);
				else console.log(table(['ID', 'Transition', 'New status'], rows.map((t) => [t.id, t.name, t.to || ''])));
			} catch (err) {
				if (s) s.error({ text: `Failed to fetch transitions for ${key}` });
				handleError(err, `${parent.name()} transitions ${key}`);
			}
		});

	parent.command('transition <key> <transition>')
		.alias('move')
		.description('Move an issue through its workflow, by transition name, ID, or target status')
		.action(async function (key, transition) {
			await runWrite(this, actions.transition, () => ({ key, transition }));
		});

	const comment = parent.command('comment')
		.description('Add, edit, or delete comments');

	comment.command('add <key> [text]')
		.description('Add a comment; on Jira Cloud it is internal unless --public')
		.option('-F, --file <path>', FILE_HELP)
		.option('--public', 'Jira Cloud Service Desk: reply to the customer')
		.action(async function (key, text, opts) {
			await runWrite(this, actions.commentAdd, () => ({ key, body: readText(text, opts.file), isPublic: Boolean(opts.public) }));
		});

	comment.command('edit <key> <commentId> [text]')
		.description('Replace the text of a comment')
		.option('-F, --file <path>', FILE_HELP)
		.action(async function (key, id, text, opts) {
			await runWrite(this, actions.commentEdit, () => ({ key, id, body: readText(text, opts.file) }));
		});

	comment.command('delete <key> <commentId>')
		.alias('rm')
		.description('Delete a comment')
		.action(async function (key, id) {
			await runWrite(this, actions.commentDelete, () => ({ key, id }));
		});

	const worklog = parent.command('worklog')
		.alias('worklogs')
		.description('List, log, or delete work on an issue');

	worklog.command('list <key>')
		.alias('ls')
		.description('List the worklogs of an issue')
		.action(async function (key) {
			const mode = getOutputMode(this);
			const s = mode === 'rich' ? spinner(`Fetching worklogs for ${key}...`).start() : null;
			try {
				const connection = connectionFor(this, types, key);
				const worklogs = await (await site(connection)).client.getWorklogs(connection, key);
				if (s) s.success({ text: `${worklogs.length} worklog(s)` });
				const rows = worklogs.map((w) => ({
					id: String(w.id),
					author: w.author?.displayName || null,
					started: w.started || null,
					timeSpent: w.timeSpent || null,
					timeSpentSeconds: w.timeSpentSeconds ?? null,
					comment: richText(w.comment) || null,
				}));
				if (mode === 'json') outputJson(rows);
				else if (mode === 'plain') for (const w of rows) console.log(`${w.id} ${w.started} ${w.timeSpent} ${w.author || 'Unknown'}${w.comment ? `: ${w.comment}` : ''}`);
				else console.log(table(['ID', 'Started', 'Time', 'Author', 'Comment'], rows.map((w) => [w.id, w.started || '', w.timeSpent || '', w.author || '', w.comment || ''])));
			} catch (err) {
				if (s) s.error({ text: `Failed to fetch worklogs for ${key}` });
				handleError(err, `${parent.name()} worklog list ${key}`);
			}
		});

	const estimateOptions = (command, verb) => command
		.option('--remaining <estimate>', 'Set the remaining estimate, e.g. 3h')
		.option('--keep-remaining', `Leave the remaining estimate as it is (default: ${verb} by the time)`);

	estimateOptions(worklog.command('add <key> <time>'), 'reduce it')
		.description('Log work on an issue, e.g. worklog add PROJ-1 "1h 30m" --started 2026-10-28 -m "Review"')
		.option('--started <time>', 'When the work started: 2026-10-28 (09:00), 2026-10-28 13:30, or ISO 8601; default now')
		.option('-m, --comment <text>', 'Work description')
		.action(async function (key, time, opts) {
			await runWrite(this, actions.worklogAdd, () => ({
				key, timeSpent: time, started: opts.started, comment: opts.comment, remaining: opts.remaining, keepRemaining: opts.keepRemaining,
			}));
		});

	estimateOptions(worklog.command('delete <key> <worklogId>'), 'increase it')
		.alias('rm')
		.description('Delete a worklog')
		.action(async function (key, id, opts) {
			await runWrite(this, actions.worklogDelete, () => ({ key, id, remaining: opts.remaining, keepRemaining: opts.keepRemaining }));
		});
}
