import { heading, field, table, pc } from '../utils/output.js';
import { standardRows, allowedLabel, typeLabel, isEmpty } from '../utils/jiraFields.js';

// The issue view lines shared by Jira Server and Service Desk: the standard fields that are set, and the
// fields asked for with --fields or --all-fields.

function shortValue(value) {
	if (value === null) return '(empty)';
	return value.length > 300 ? `${value.slice(0, 297)}...` : value;
}

// Fields the view already shows on their own line when they have a value; --fields and --all-fields
// do not print them again.
const VIEW_FIELDS = new Set([
	'summary', 'status', 'priority', 'issuetype', 'assignee', 'reporter', 'labels', 'components', 'created', 'updated', 'description',
	'resolution', 'resolutiondate', 'timetracking', 'fixVersions', 'duedate', 'parent',
]);

function notShown(f, extra) {
	return extra.filter((e) => !(VIEW_FIELDS.has(e.id) && !isEmpty(f[e.id]) && e.value !== null));
}

export function plainExtras(f, extra) {
	for (const [label, value] of standardRows(f)) console.log(`${label}: ${value}`);
	if (!extra) return;
	extra = notShown(f, extra);
	if (!extra.length) return;
	console.log('Fields:');
	for (const e of extra) console.log(`  ${e.name}${e.name !== e.id ? ` (${e.id})` : ''}: ${shortValue(e.value)}`);
}

export function richExtras(f, extra) {
	for (const [label, value] of standardRows(f)) field(label, value);
	if (!extra) return;
	extra = notShown(f, extra);
	if (!extra.length) return;
	heading('Fields');
	for (const e of extra) field(`${e.name}${e.name !== e.id ? ` ${pc.dim(`(${e.id})`)}` : ''}`, e.value === null ? pc.dim('(empty)') : shortValue(e.value));
}

// --- Field metadata (`fields`) ---

// Required fields first, because a missing one is the most common reason a create fails.
export function curateFieldMetaJson(list, count) {
	return [...list]
		.sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)))
		.map((f) => ({
			id: f.id,
			name: f.name || f.id,
			type: f.schema?.type || null,
			items: f.schema?.items || null,
			custom: f.schema?.custom || null,
			required: Boolean(f.required),
			hasDefaultValue: Boolean(f.hasDefaultValue),
			operations: f.operations || [],
			allowedValues: (f.allowedValues || []).slice(0, count).map((v) => ({ id: v?.id != null ? String(v.id) : null, value: allowedLabel(v) })),
			allowedValuesTotal: (f.allowedValues || []).length,
		}));
}

function allowedText(f) {
	if (!f.allowedValuesTotal) return '';
	const shown = f.allowedValues.map((v) => (v.id && v.id !== v.value ? `${v.value} [${v.id}]` : v.value));
	const more = f.allowedValuesTotal - f.allowedValues.length;
	return more > 0 ? `${shown.join(', ')}, … ${more} more` : shown.join(', ');
}

function typeText(f) {
	return typeLabel({ type: f.type, items: f.items, custom: f.custom });
}

export function plainFieldMeta(rows, title) {
	console.log(title);
	for (const f of rows) {
		const allowed = allowedText(f);
		console.log(`${f.required ? 'REQUIRED ' : ''}${f.id} "${f.name}" ${typeText(f)}${f.operations.length ? ` ops=${f.operations.join('/')}` : ''}${allowed ? ` allowed: ${allowed}` : ''}`);
	}
}

export function formatFieldMeta(rows, title) {
	heading(title);
	console.log(table(['Field', 'ID', 'Type', 'Required', 'Allowed values'], rows.map((f) => [
		f.name,
		pc.dim(f.id),
		typeText(f),
		f.required ? pc.bold(pc.red('required')) : '',
		allowedText(f),
	])));
}
