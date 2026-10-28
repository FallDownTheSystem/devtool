import { spinner } from '../utils/output.js';
import { handleError } from '../utils/errors.js';
import { getOutputMode, outputJson } from '../utils/mode.js';
import { connectionFor } from '../utils/connection.js';
import { metaList } from '../utils/jiraFields.js';
import { curateFieldMetaJson, plainFieldMeta, formatFieldMeta } from '../formatters/issueFields.js';
import { site } from '../clients/jira.js';

export const VIEW_FIELDS_HELP = 'Also show these fields, by ID or display name (comma-separated, case-insensitive)';
export const VIEW_ALL_FIELDS_HELP = 'Show every non-empty field with its ID and display name';

// `fields <key>` shows what an edit can set; `fields --create` shows what a create needs.
export function addIssueFieldsCommand(parent, { types }) {
	parent.command('fields [key]')
		.description('List the fields you can set on an issue (edit metadata), or with --create the fields a new one takes, with type, required flag, and allowed values')
		.option('--create', 'Show the create metadata of a project and issue type instead')
		.option('-p, --project <key>', 'Project for --create (default: the connection\'s default project)')
		.option('-t, --type <name>', 'Issue type name or ID for --create', 'Task')
		.option('--values <n>', 'Allowed values to show per field', '5')
		.addHelpText('after', `
Examples:
  dev ${parent.name()} fields PROJ-1                       fields an edit can set
  dev ${parent.name()} fields --create --project PROJ --type Bug
  dev ${parent.name()} edit PROJ-1 --field "<display name>=<value>"`)
		.action(async function (key, opts) {
			const mode = getOutputMode(this);
			const s = mode === 'rich' ? spinner('Fetching field metadata...').start() : null;
			try {
				const connection = connectionFor(this, types, opts.create ? opts.project : key);
				const { client } = await site(connection);
				let list;
				let title;
				if (opts.create) {
					const project = opts.project || connection.defaultProject;
					if (!project) throw new Error('No project specified. Pass --project <key> or set defaultProject on the connection.');
					const issueType = /^\d+$/.test(opts.type) ? { id: opts.type } : { name: opts.type };
					const meta = await client.getCreateMeta(connection, project, issueType);
					list = metaList(meta.fields);
					title = `Create fields for a ${meta.issueType.name} in ${project}`;
				} else {
					if (!key) throw new Error('Give an issue key, or --create with --project and --type.');
					list = metaList(await client.getEditMeta(connection, key));
					title = `Editable fields of ${key}`;
				}
				const rows = curateFieldMetaJson(list, Math.max(0, parseInt(opts.values, 10) || 0));
				if (s) s.success({ text: `${rows.length} field(s), ${rows.filter((f) => f.required).length} required` });
				if (mode === 'json') outputJson(rows);
				else if (mode === 'plain') plainFieldMeta(rows, title);
				else formatFieldMeta(rows, title);
			} catch (err) {
				if (s) s.error({ text: 'Failed to fetch field metadata' });
				handleError(err, `${parent.name()} fields ${key || '--create'}`);
			}
		});
}
