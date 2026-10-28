import { JIRA_TYPES, site } from '../clients/jira.js';
import { richText } from '../utils/markup.js';
import {
	metaList, findField, coerceFieldValue, parseLoose, missingRequired, missingMessage, siteFields, readable,
} from '../utils/jiraFields.js';
import { requireText } from './require.js';

// The issue actions of `dev jira`, for Jira Server/Data Center and Jira Cloud alike. Parameters hold
// plain text and user references; `site(connection)` maps them to the API's format when a request is
// built: wiki markup and user names on Server, ADF and account IDs on Cloud. `route` names the issue or
// project that picks the connection when no --connection is given.

function fields(params, { text, user } = { text: (v) => v, user: (v) => v }) {
	const result = {};
	if (params.project) result.project = { key: params.project };
	if (params.issueType) result.issuetype = { name: params.issueType };
	if (params.summary !== undefined) result.summary = params.summary;
	if (params.description !== undefined) result.description = text(params.description);
	if (params.priority !== undefined) result.priority = { name: params.priority };
	if (params.labels !== undefined) result.labels = params.labels;
	if (params.assignee !== undefined) result.assignee = params.assignee === null ? null : user(params.assignee);
	if (params.parent !== undefined) result.parent = { key: params.parent };
	Object.assign(result, params.fields);
	return result;
}

// A --field that repeats a dedicated option would silently replace it, and the summary and preview would
// then describe a request other than the one sent. Checked on the given names before any request and
// again on the resolved field IDs.
function rejectOverlap(params) {
	const named = Object.keys(fields({ ...params, fields: {} }));
	const overlap = Object.keys(params.fields || {}).filter((key) => named.includes(key) || named.includes(key.toLowerCase()));
	if (overlap.length) throw new Error(`--field ${overlap.join(', ')} repeats a dedicated option; use only one of them.`);
	return params;
}

// Resolves each `--field` name (ID or display name) against the create or edit metadata and converts
// its text to the value the field's schema expects, so the preview shows what is sent.
async function resolveFields(connection, s, given, meta, where) {
	const result = { fields: {}, fieldNames: {} };
	for (const [ref, raw] of Object.entries(given)) {
		const field = findField(meta, ref);
		if (!field) {
			const known = findField((await siteFields(connection, s.client)).map((f) => ({ id: f.id, name: f.name })), ref);
			throw new Error(known
				? `Field ${known.name} (${known.id}) is not on the ${where} screen, or you cannot set it.`
				: `Unknown field "${ref}". Give a field ID or display name; \`fields\` lists the fields you can set.`);
		}
		result.fields[field.id] = coerceFieldValue(field, raw, s);
		if (field.name && field.name !== field.id) result.fieldNames[field.id] = field.name;
	}
	return result;
}

function looseFields(given) {
	return { fields: Object.fromEntries(Object.entries(given).map(([key, raw]) => [key, parseLoose(raw)])), fieldNames: {} };
}

function fieldLabel(params, key) {
	const name = params.fieldNames?.[key];
	return name ? `${name} (${key})` : key;
}

function fieldDetails(params) {
	const details = [];
	if (params.project) details.push(['Project', params.project]);
	if (params.issueType) details.push(['Type', params.issueType]);
	if (params.summary !== undefined) details.push(['Summary', params.summary]);
	if (params.priority !== undefined) details.push(['Priority', params.priority]);
	if (params.labels !== undefined) details.push(['Labels', params.labels.join(', ') || '(none)']);
	if (params.assignee !== undefined) details.push(['Assignee', params.assignee ?? '(unassigned)']);
	if (params.parent !== undefined) details.push(['Parent', params.parent]);
	for (const [key, value] of Object.entries(params.fields || {})) details.push([fieldLabel(params, key), JSON.stringify(value)]);
	if (params.description !== undefined) details.push(['Description', params.description || '(empty)']);
	return details;
}

function userText(user) {
	if (!user) return '(unassigned)';
	const id = user.name || user.accountId;
	return user.displayName && id && id !== user.displayName ? `${user.displayName} (${id})` : user.displayName || id;
}

// The current value of each field an edit changes, keyed by its detail label.
function currentValues(issue, params) {
	const f = issue.fields || {};
	const current = {};
	if (params.summary !== undefined) current.Summary = f.summary ?? '(empty)';
	if (params.priority !== undefined) current.Priority = f.priority?.name ?? '(none)';
	if (params.labels !== undefined) current.Labels = (f.labels || []).join(', ') || '(none)';
	if (params.assignee !== undefined) current.Assignee = userText(f.assignee);
	if (params.parent !== undefined) current.Parent = f.parent?.key ?? '(none)';
	for (const key of Object.keys(params.fields || {})) current[fieldLabel(params, key)] = readable(f[key]) ?? '(empty)';
	if (params.description !== undefined) current.Description = richText(f.description) || '(empty)';
	return current;
}

const short = (text) => !String(text).includes('\n') && String(text).length <= 60;

// Puts the current value next to each new one: "old → new" when both are short, otherwise both in full.
function withCurrent(details, current) {
	if (!current) return details;
	return details.flatMap(([label, value]) => {
		if (!(label in current)) return [[label, value]];
		const before = current[label];
		return short(before) && short(value)
			? [[label, `${before} → ${value}`]]
			: [[`${label} (current)`, before], [`${label} (new)`, value]];
	});
}

async function currentComment(connection, { key, id }) {
	const comment = await (await site(connection)).client.getComment(connection, key, id);
	return { author: comment.author?.displayName || 'Unknown', current: richText(comment.body) };
}

async function currentIssue(connection, { key }) {
	const issue = await (await site(connection)).client.getIssue(connection, key);
	return { currentSummary: issue.fields?.summary, subtasks: (issue.fields?.subtasks || []).length };
}

const byKey = (input) => input.key;

export const create = {
	name: 'jira.issue.create',
	type: JIRA_TYPES,
	route: (input) => input.project,
	async prepare(connection, input) {
		// A --field project or issuetype (e.g. by ID) replaces the defaults instead of colliding with them.
		const given = input.fields || {};
		const project = given.project ? input.project : input.project || connection.defaultProject;
		if (!project && !given.project) throw new Error('No project specified. Pass --project <key> or set defaultProject on the connection.');
		if (!input.summary) throw new Error('A summary is required. Pass --summary <text>.');
		const issueType = given.issuetype ? input.issueType : input.issueType || 'Task';
		rejectOverlap({ ...input, project, issueType });
		// A project or issue type given by --field cannot be looked up, so those values are taken as given.
		if (given.project || given.issuetype) return { ...input, project, issueType, ...looseFields(given) };
		const s = await site(connection);
		const { fields: meta } = await s.client.getCreateMeta(connection, project, { name: issueType });
		const list = metaList(meta);
		const resolved = await resolveFields(connection, s, given, list, 'create');
		const params = rejectOverlap({ ...input, project, issueType, ...resolved });
		const missing = missingRequired(list, fields(params));
		if (missing.length) {
			throw new Error(missingMessage(missing, `a ${issueType} in ${project}`, `\`fields --create --project ${project} --type "${issueType}"\``));
		}
		return params;
	},
	summary: (p) => `Create ${p.issueType ? `a ${p.issueType}` : 'an issue'} in ${p.project || 'the --field project'}: ${p.summary}`,
	details: fieldDetails,
	run: async (connection, p) => {
		const s = await site(connection);
		return s.client.createIssue(connection, fields(p, s));
	},
	report: (issue) => ({ message: `Created ${issue.key}`, json: { key: issue.key, id: issue.id } }),
};

// The preview reads the issue so the approval shows what each changed field holds now.
export const edit = {
	name: 'jira.issue.edit',
	type: JIRA_TYPES,
	route: byKey,
	async prepare(connection, input) {
		if (!Object.keys(fields(input)).length) {
			throw new Error('Nothing to change. Pass at least one field option, such as --summary or --field.');
		}
		rejectOverlap(input);
		const given = input.fields || {};
		if (!Object.keys(given).length) return { ...input, fieldNames: {} };
		const s = await site(connection);
		const meta = metaList(await s.client.getEditMeta(connection, input.key));
		return rejectOverlap({ ...input, ...await resolveFields(connection, s, given, meta, 'edit') });
	},
	async preview(connection, p) {
		const issue = await (await site(connection)).client.getIssue(connection, p.key);
		return { currentSummary: issue.fields?.summary, current: currentValues(issue, p) };
	},
	summary: (p) => `Edit ${p.key}`,
	details: (p) => [['Issue', `${p.key} (${p.currentSummary})`], ...withCurrent(fieldDetails(p), p.current)],
	run: async (connection, p) => {
		const s = await site(connection);
		return s.client.editIssue(connection, p.key, fields(p, s));
	},
	report: (_, p) => ({ message: `Updated ${p.key}`, json: { key: p.key } }),
};

export const remove = {
	name: 'jira.issue.delete',
	type: JIRA_TYPES,
	route: byKey,
	preview: currentIssue,
	summary: (p) => `Delete ${p.key}`,
	details: (p) => [
		['Issue', `${p.key} (${p.currentSummary})`],
		['Subtasks', p.subtasks ? `${p.subtasks}${p.deleteSubtasks ? ', deleted with the issue' : ''}` : 'none'],
	],
	run: async (connection, p) => (await site(connection)).client.deleteIssue(connection, p.key, p.deleteSubtasks),
	report: (_, p) => ({ message: `Deleted ${p.key}`, json: { key: p.key } }),
};

// The transition is resolved to an ID when the action is prepared, so approval shows the exact target status.
export const transition = {
	name: 'jira.issue.transition',
	type: JIRA_TYPES,
	route: byKey,
	async prepare(connection, input) {
		const transitions = await (await site(connection)).client.getTransitions(connection, input.key);
		const wanted = input.transition.toLowerCase();
		const match = transitions.find((t) => String(t.id) === input.transition)
			|| transitions.find((t) => t.name?.toLowerCase() === wanted)
			|| transitions.find((t) => t.to?.name?.toLowerCase() === wanted);
		if (!match) {
			const available = transitions.map((t) => `${t.name} (${t.id}) → ${t.to?.name}`).join(', ') || 'none';
			throw new Error(`No transition "${input.transition}" for ${input.key}. Available: ${available}`);
		}
		return { key: input.key, transitionId: String(match.id), transitionName: match.name, toStatus: match.to?.name };
	},
	summary: (p) => `Transition ${p.key} to ${p.toStatus || p.transitionName}`,
	details: (p) => [['Issue', p.key], ['Transition', `${p.transitionName} (${p.transitionId})`], ['New status', p.toStatus || 'unknown']],
	run: async (connection, p) => (await site(connection)).client.transitionIssue(connection, p.key, p.transitionId),
	report: (_, p) => ({ message: `Moved ${p.key} to ${p.toStatus || p.transitionName}`, json: { key: p.key, status: p.toStatus || null } }),
};

// On Jira Cloud a comment is internal unless --public; Server has no customer-visible replies.
export const commentAdd = {
	name: 'jira.comment.add',
	type: JIRA_TYPES,
	route: byKey,
	async prepare(connection, input) {
		requireText(input.body, 'comment');
		const { cloud } = await site(connection);
		if (input.isPublic && !cloud) throw new Error('--public replies to a Service Desk customer, which only Jira Cloud supports. Leave it out on Jira Server/Data Center.');
		return { ...input, cloud };
	},
	summary: (p) => `Add ${p.cloud ? (p.isPublic ? 'a public reply' : 'an internal comment') : 'a comment'} to ${p.key}`,
	details: (p) => [
		['Issue', p.key],
		...(p.cloud ? [['Visibility', p.isPublic ? 'public: the customer sees it' : 'internal: agents only']] : []),
		['Comment', p.body],
	],
	run: async (connection, p) => (await site(connection)).client.addComment(connection, p.key, p.body, { isPublic: p.isPublic }),
	report: (comment, p) => ({ message: `Added comment ${comment.id} to ${p.key}`, json: { key: p.key, id: String(comment.id) } }),
};

export const commentEdit = {
	name: 'jira.comment.edit',
	type: JIRA_TYPES,
	route: byKey,
	async prepare(connection, input) {
		requireText(input.body, 'comment');
		return input;
	},
	preview: currentComment,
	summary: (p) => `Edit comment ${p.id} on ${p.key}`,
	details: (p) => [['Issue', p.key], ['Current text', p.current], ['New text', p.body]],
	run: async (connection, p) => {
		const s = await site(connection);
		return s.client.updateComment(connection, p.key, p.id, s.text(p.body));
	},
	report: (_, p) => ({ message: `Updated comment ${p.id} on ${p.key}`, json: { key: p.key, id: String(p.id) } }),
};

export const commentDelete = {
	name: 'jira.comment.delete',
	type: JIRA_TYPES,
	route: byKey,
	preview: currentComment,
	summary: (p) => `Delete comment ${p.id} on ${p.key}`,
	details: (p) => [['Issue', p.key], ['Author', p.author], ['Comment', p.current]],
	run: async (connection, p) => (await site(connection)).client.deleteComment(connection, p.key, p.id),
	report: (_, p) => ({ message: `Deleted comment ${p.id} on ${p.key}`, json: { key: p.key, id: String(p.id) } }),
};

// --- Worklogs ---

const DURATION = /^(?:\s*\d+(?:\.\d+)?\s*[wdhm])+\s*$/i;

function requireDuration(value, flag) {
	if (!DURATION.test(value || '')) throw new Error(`${flag} "${value}" is not a Jira duration. Use units w, d, h, m, e.g. 1h 30m or 2d.`);
	return value.trim().replace(/\s+/g, ' ');
}

const pad = (n, width = 2) => String(Math.abs(n)).padStart(width, '0');

// Jira takes the start as yyyy-MM-dd'T'HH:mm:ss.SSSZ; local time keeps the worklog on the intended day.
export function jiraDateTime(date) {
	const offset = -date.getTimezoneOffset();
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`;
}

// A date alone starts at 09:00 local time; a date and time without a zone is local time.
export function parseStarted(value, now = new Date()) {
	if (value === undefined) return jiraDateTime(now);
	const text = value.trim();
	const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
	const date = local
		? new Date(+local[1], +local[2] - 1, +local[3], local[4] === undefined ? 9 : +local[4], +(local[5] ?? 0), +(local[6] ?? 0))
		: new Date(text);
	if (Number.isNaN(date.getTime())) throw new Error(`--started "${value}" is not a date. Use 2026-10-28, 2026-10-28 13:30, or an ISO 8601 time.`);
	return jiraDateTime(date);
}

// --remaining sets the remaining estimate, --keep-remaining leaves it; by default Jira adjusts it by the time logged.
export function estimateParams({ remaining, keepRemaining }) {
	if (remaining !== undefined && keepRemaining) throw new Error('Give --remaining or --keep-remaining, not both.');
	if (remaining !== undefined) return { adjustEstimate: 'new', newEstimate: requireDuration(remaining, '--remaining') };
	if (keepRemaining) return { adjustEstimate: 'leave' };
	return { adjustEstimate: 'auto' };
}

function estimateText(estimate, verb) {
	if (estimate.adjustEstimate === 'new') return `set to ${estimate.newEstimate}`;
	if (estimate.adjustEstimate === 'leave') return 'unchanged';
	return `${verb} by the time spent`;
}

export const worklogAdd = {
	name: 'jira.worklog.add',
	type: JIRA_TYPES,
	route: byKey,
	async prepare(connection, input) {
		return {
			key: input.key,
			timeSpent: requireDuration(input.timeSpent, 'Time spent'),
			started: parseStarted(input.started),
			comment: input.comment || undefined,
			estimate: estimateParams(input),
		};
	},
	async preview(connection, p) {
		const issue = await (await site(connection)).client.getIssue(connection, p.key);
		return { currentSummary: issue.fields?.summary, currentRemaining: issue.fields?.timetracking?.remainingEstimate || null };
	},
	summary: (p) => `Log ${p.timeSpent} on ${p.key}`,
	details: (p) => [
		['Issue', p.currentSummary ? `${p.key} (${p.currentSummary})` : p.key],
		['Time spent', p.timeSpent],
		['Started', p.started],
		...(p.comment ? [['Comment', p.comment]] : []),
		['Remaining estimate', `${estimateText(p.estimate, 'reduced')}${p.currentRemaining ? ` (now ${p.currentRemaining})` : ''}`],
	],
	run: async (connection, p) => (await site(connection)).client.addWorklog(connection, p.key, p, p.estimate),
	report: (worklog, p) => ({
		message: `Logged ${p.timeSpent} on ${p.key} (worklog ${worklog?.id})`,
		json: { key: p.key, id: worklog?.id != null ? String(worklog.id) : null, timeSpent: p.timeSpent, started: p.started },
	}),
};

export const worklogDelete = {
	name: 'jira.worklog.delete',
	type: JIRA_TYPES,
	route: byKey,
	prepare: async (connection, input) => ({ key: input.key, id: input.id, estimate: estimateParams(input) }),
	async preview(connection, p) {
		const worklog = await (await site(connection)).client.getWorklog(connection, p.key, p.id);
		return {
			author: worklog.author?.displayName || 'Unknown',
			timeSpent: worklog.timeSpent,
			started: worklog.started,
			comment: richText(worklog.comment),
		};
	},
	summary: (p) => `Delete worklog ${p.id} on ${p.key}`,
	details: (p) => [
		['Issue', p.key],
		['Author', p.author],
		['Time spent', p.timeSpent],
		['Started', p.started],
		...(p.comment ? [['Comment', p.comment]] : []),
		['Remaining estimate', estimateText(p.estimate, 'increased')],
	],
	run: async (connection, p) => (await site(connection)).client.deleteWorklog(connection, p.key, p.id, p.estimate),
	report: (_, p) => ({ message: `Deleted worklog ${p.id} on ${p.key}`, json: { key: p.key, id: String(p.id) } }),
};
