import { richText } from './markup.js';

// Shared by Jira Server and Jira Cloud (Service Desk): paged metadata, field names, schema-aware values,
// and readable forms of field values. Nothing here knows about a particular project or plugin.

// Collects the items of an offset-paged endpoint (startAt/maxResults/total or isLast).
export async function collectPages(fetchPage, itemsOf, limit = 1000) {
	const items = [];
	for (;;) {
		const data = await fetchPage(items.length);
		const page = itemsOf(data) || [];
		items.push(...page);
		const done = !page.length
			|| data.isLast === true
			|| (typeof data.total === 'number' && items.length >= data.total)
			|| (data.isLast === undefined && data.total === undefined && (data.maxResults === undefined || page.length < data.maxResults))
			|| items.length >= limit;
		if (done) return items;
	}
}

// `wanted` is { id } or { name }; names match case-insensitively.
export function pickIssueType(types, wanted, project) {
	const name = wanted.name?.toLowerCase();
	const match = types.find((t) => (wanted.id !== undefined && String(t.id) === String(wanted.id)) || (name && t.name?.toLowerCase() === name));
	if (!match) {
		const available = types.map((t) => t.name).join(', ') || 'none';
		throw new Error(`Issue type "${wanted.name ?? wanted.id}" is not available in project ${project}. Available: ${available}`);
	}
	return match;
}

// editmeta and the expand form of createmeta key fields by ID; the paged createmeta returns a list.
export function metaList(fields) {
	if (Array.isArray(fields)) return fields.map((f) => ({ ...f, id: f.fieldId || f.key }));
	return Object.entries(fields || {}).map(([id, f]) => ({ ...f, id }));
}

export function typeLabel(schema = {}) {
	if (!schema.type) return 'unknown';
	const type = schema.items ? `${schema.type}<${schema.items}>` : schema.type;
	return schema.custom ? `${type}, ${schema.custom}` : type;
}

export function allowedLabel(value) {
	if (value === null || typeof value !== 'object') return String(value);
	return String(value.value ?? value.name ?? value.key ?? value.id);
}

export function allowedSample(meta, count = 5) {
	const values = meta.allowedValues || [];
	const shown = values.slice(0, count).map(allowedLabel);
	return values.length > count ? [...shown, `… ${values.length - count} more`] : shown;
}

const fieldLists = new Map();

// The field list of a site (/rest/api/2/field or /3/field), read once per process.
export function siteFields(connection, client) {
	const key = `${connection.type} ${connection.baseUrl}`;
	if (!fieldLists.has(key)) fieldLists.set(key, client.getFields(connection));
	return fieldLists.get(key);
}

// Finds `ref`, a field ID or display name (case-insensitive), among `entries` of { id, name }.
export function findField(entries, ref) {
	const byId = entries.find((f) => f.id === ref);
	if (byId) return byId;
	const lower = ref.toLowerCase();
	const byName = entries.filter((f) => f.name?.toLowerCase() === lower);
	if (byName.length > 1) {
		throw new Error(`More than one field is named "${ref}": ${byName.map((f) => f.id).join(', ')}. Use the field ID.`);
	}
	return byName[0];
}

// Explicit JSON ({...}, [...], "..." or null) is sent unchanged; anything else is converted by the schema.
const EXPLICIT_JSON = /^\s*(?:[{["]|null\s*$)/;

// `--field name=value` without schema information: the value is JSON when it parses.
export function parseLoose(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

function describe(meta) {
	return meta.name && meta.name !== meta.id ? `${meta.name} (${meta.id})` : meta.id;
}

function misfit(meta, text, reason) {
	const sample = allowedSample(meta);
	const allowed = sample.length ? ` Allowed values: ${sample.join(', ')}.` : '';
	return new Error(`--field ${describe(meta)} has type ${typeLabel(meta.schema)}; ${reason ?? `"${text}" does not fit it`}.${allowed}`);
}

// Matches a value against allowedValues by ID, value, name, or key; an empty list allows anything.
function allowed(meta, text) {
	const values = meta.allowedValues;
	if (!values?.length) return undefined;
	const lower = text.toLowerCase();
	const match = values.find((v) => String(v.id) === text)
		|| values.find((v) => [v.value, v.name, v.key].some((s) => typeof s === 'string' && s.toLowerCase() === lower));
	if (!match) throw misfit(meta, text);
	return match;
}

const NAMED = new Set(['priority', 'resolution', 'issuetype', 'version', 'component', 'securitylevel']);

// Multi-line text fields take the site's rich-text format (ADF on Jira Cloud).
function isRichText(meta) {
	const schema = meta.schema || {};
	return ['description', 'environment'].includes(schema.system) || /:textarea$/.test(schema.custom || '');
}

function single(meta, type, text, { user, text: rich }) {
	switch (type) {
		case 'string':
			return rich && isRichText(meta) ? rich(text) : text;
		case 'date':
		case 'datetime':
			return text;
		case 'number': {
			const number = Number(text);
			if (text.trim() === '' || !Number.isFinite(number)) throw misfit(meta, text, `"${text}" is not a number`);
			return number;
		}
		case 'option': {
			const match = allowed(meta, text);
			return match ? { id: String(match.id) } : { value: text };
		}
		case 'user':
			return user(text);
		case 'group':
			return { name: text };
		case 'project':
			return { key: text };
		default: {
			if (NAMED.has(type)) {
				const match = allowed(meta, text);
				return match ? { id: String(match.id) } : { name: text };
			}
			// Plugin and other unknown types: the raw text, never a number, which such fields often reject.
			return text;
		}
	}
}

// Converts the text of a `--field` to the API value its schema expects. `user` and `text` map a user
// reference and plain text to the site's format.
export function coerceFieldValue(meta, raw, format) {
	if (EXPLICIT_JSON.test(raw)) {
		try {
			return JSON.parse(raw);
		} catch {
			throw new Error(`--field ${describe(meta)}: the value starts like JSON but is not valid JSON.`);
		}
	}
	const schema = meta.schema || {};
	// A plugin field (a custom type outside com.atlassian) defines its own value format, which is
	// usually the text of an ID; it gets the text as a string, never a number or an option object.
	if (schema.custom && !schema.custom.startsWith('com.atlassian.') && schema.type !== 'array') return raw;
	if (schema.type === 'array') {
		const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
		return items.map((text) => single(meta, schema.items || 'string', text, format));
	}
	return single(meta, schema.type, raw, format);
}

// Required fields without a default that `fields` does not set. Jira fills in the project and issue type
// from the request and the reporter from the caller.
export function missingRequired(meta, fields) {
	return meta.filter((f) => f.required && !f.hasDefaultValue && !['project', 'issuetype', 'reporter'].includes(f.id) && !(f.id in fields));
}

export function missingMessage(missing, where, hint) {
	const lines = missing.map((f) => {
		const sample = allowedSample(f, 3);
		return `  ${describe(f)}: ${typeLabel(f.schema)}${sample.length ? `, e.g. ${sample.join(', ')}` : ''}`;
	});
	return `Missing required field(s) for ${where}:\n${lines.join('\n')}\nSet them with --field "<name>=<value>"; ${hint} lists all fields.`;
}

export function isEmpty(value) {
	if (value === null || value === undefined || value === '') return true;
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === 'object') return Object.keys(value).length === 0;
	return false;
}

// A short readable form of a field value: users by display name, options by value, objects with a
// name (versions, components, plugin entities such as accounts) as "name (key)", arrays joined.
export function readable(value) {
	if (isEmpty(value)) return null;
	if (Array.isArray(value)) return value.map(readable).filter(Boolean).join(', ') || null;
	if (typeof value !== 'object') return String(value);
	if (value.type === 'doc') return richText(value) || null;
	if (value.displayName) return value.displayName;
	if (value.value !== undefined) return value.child ? `${value.value} / ${readable(value.child)}` : String(value.value);
	if (value.name) return value.key && value.key !== value.name ? `${value.name} (${value.key})` : String(value.name);
	if (value.key) return String(value.key);
	if ('originalEstimate' in value || 'remainingEstimate' in value || 'timeSpent' in value) return timeTrackingText(value);
	return JSON.stringify(value);
}

function timeTrackingText(t) {
	return [
		t.originalEstimate && `original ${t.originalEstimate}`,
		t.remainingEstimate && `remaining ${t.remainingEstimate}`,
		t.timeSpent && `spent ${t.timeSpent}`,
	].filter(Boolean).join(', ') || null;
}

// Fields every issue view shows when they are set.
export function standardJson(f) {
	const t = f.timetracking || {};
	return {
		resolution: f.resolution?.name || null,
		resolutionDate: f.resolutiondate || null,
		timeTracking: timeTrackingText(t) ? {
			originalEstimate: t.originalEstimate || null,
			remainingEstimate: t.remainingEstimate || null,
			timeSpent: t.timeSpent || null,
		} : null,
		fixVersions: (f.fixVersions || []).map((v) => v.name),
		dueDate: f.duedate || null,
		parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || null } : null,
	};
}

export function standardRows(f) {
	const s = standardJson(f);
	return [
		['Resolution', s.resolution],
		['Resolved', s.resolutionDate],
		['Time tracking', timeTrackingText(f.timetracking || {})],
		['Fix versions', s.fixVersions.join(', ')],
		['Due', s.dueDate],
		['Parent', s.parent && [s.parent.key, s.parent.summary].filter(Boolean).join(' ')],
	].filter(([, value]) => value);
}

// The fields asked for with --fields (IDs or display names) or --all-fields (every non-empty field).
// Names come from the issue's `names` expansion.
export function requestedFields(issue, { fields: list, allFields }) {
	if (!list && !allFields) return null;
	const values = issue.fields || {};
	const entries = Object.keys({ ...issue.names, ...values }).map((id) => ({ id, name: issue.names?.[id] || id }));
	const ids = allFields
		? Object.keys(values).filter((id) => !isEmpty(values[id]))
		: list.split(',').map((s) => s.trim()).filter(Boolean).map((ref) => {
			const found = findField(entries, ref);
			if (!found) throw new Error(`Unknown field "${ref}". --all-fields lists the fields of the issue by name.`);
			return found.id;
		});
	return ids.map((id) => ({ id, name: issue.names?.[id] || id, value: readable(values[id]), raw: values[id] ?? null }));
}
