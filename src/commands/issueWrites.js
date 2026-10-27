import { table, spinner } from '../utils/output.js';
import { handleError } from '../utils/errors.js';
import { getOutputMode, outputJson } from '../utils/mode.js';
import { connectionFor } from '../utils/connection.js';
import { runWrite, readText, collect, parseFields, FILE_HELP } from '../utils/write.js';

function issueOptions(command, { userHelp }) {
	return command
		.option('-s, --summary <text>', 'Summary')
		.option('-d, --description <text>', 'Description')
		.option('--description-file <path>', 'Read the description from a file ("-" for standard input)')
		.option('--priority <name>', 'Priority name')
		.option('--labels <list>', 'Comma-separated labels; replaces the current labels')
		.option('--assignee <user>', userHelp)
		.option('--parent <key>', 'Parent issue key')
		.option('--field <field=value>', 'Set any field by ID, e.g. customfield_10010=5; the value is parsed as JSON when valid (repeatable)', collect, []);
}

function issueInput(opts) {
	const input = { fields: parseFields(opts.field) };
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

// Adds the write commands shared by Jira Server (`dev jira`) and Service Desk Cloud (`dev sd`).
export function addIssueWriteCommands(parent, { dialect, actions, noun, userHelp }) {
	const { type, client, publicComments } = dialect;
	issueOptions(parent.command('create'), { userHelp })
		.description(`Create ${noun}`)
		.option('-p, --project <key>', 'Project key (overrides the default project)')
		.option('-t, --type <name>', 'Issue type (default: Task)')
		.action(async function (opts) {
			await runWrite(this, actions.create, () => ({ ...issueInput(opts), project: opts.project, issueType: opts.type }));
		});

	issueOptions(parent.command('edit <key>'), { userHelp })
		.description(`Change fields of ${noun}`)
		.option('--unassign', 'Remove the assignee')
		.action(async function (key, opts) {
			await runWrite(this, actions.edit, () => ({ ...issueInput(opts), key }));
		});

	parent.command('delete <key>')
		.alias('rm')
		.description(`Delete ${noun}`)
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
				const transitions = await client.getTransitions(connectionFor(this, type), key);
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

	const add = comment.command('add <key> [text]')
		.description('Add a comment')
		.option('-F, --file <path>', FILE_HELP);
	if (publicComments) add.option('--public', 'Reply to the customer; without it the comment is internal');
	add.action(async function (key, text, opts) {
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
}
