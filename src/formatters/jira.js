import { table, heading, field, divider, pc } from '../utils/output.js';
import { standardJson } from '../utils/jiraFields.js';
import { richText } from '../utils/markup.js';
import { plainExtras, richExtras } from './issueFields.js';

function statusColor(name) {
	if (!name) return pc.dim('Unknown');
	const lower = name.toLowerCase();
	if (lower === 'done' || lower === 'closed' || lower === 'resolved') return pc.green(name);
	if (lower === 'in progress' || lower === 'in review' || lower === 'waiting for support') return pc.blue(name);
	if (lower === 'to do' || lower === 'open' || lower === 'backlog' || lower === 'waiting for customer') return pc.yellow(name);
	return name;
}

function priorityColor(name) {
	if (!name) return pc.dim('None');
	const lower = name.toLowerCase();
	if (lower === 'highest' || lower === 'blocker') return pc.red(pc.bold(name));
	if (lower === 'high' || lower === 'critical') return pc.red(name);
	if (lower === 'low' || lower === 'minor') return pc.dim(name);
	if (lower === 'lowest' || lower === 'trivial') return pc.dim(name);
	return name;
}

function relativeTime(dateStr) {
	if (!dateStr) return '';
	const diff = Date.now() - new Date(dateStr).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(dateStr).toLocaleDateString();
}

function extractSprint(fields) {
	for (const key of Object.keys(fields)) {
		if (!key.startsWith('customfield_')) continue;
		const val = fields[key];
		if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0].name) {
			if ('state' in val[0] || 'goal' in val[0]) {
				return val[val.length - 1].name;
			}
		}
		if (typeof val === 'string' && val.includes('com.atlassian.greenhopper')) {
			const match = val.match(/name=([^,\]]+)/);
			if (match) return match[1];
		}
	}
	return null;
}

function extractStoryPoints(fields) {
	for (const key of Object.keys(fields)) {
		if (!key.startsWith('customfield_')) continue;
		const val = fields[key];
		if (typeof val === 'number' && val > 0 && val <= 100) {
			const keyNum = parseInt(key.replace('customfield_', ''), 10);
			if (keyNum > 10000) return val;
		}
	}
	return null;
}

// Jira Cloud returns rich text as ADF, Server as a wiki-markup string.
function descriptionText(desc) {
	return richText(desc);
}

// The request type of a Service Desk issue, from the customer request type field it carries.
function requestType(fields) {
	for (const key of Object.keys(fields)) {
		if (!key.startsWith('customfield_')) continue;
		const val = fields[key];
		if (val && typeof val === 'object' && val.requestType?.name) return val.requestType.name;
	}
	return null;
}

// --- JSON curators ---

// `extra` is the result of requestedFields: the fields asked for with --fields or --all-fields.
export function curateIssueJson(issue, extra) {
	const f = issue.fields;
	return {
		key: issue.key,
		summary: f.summary,
		status: f.status?.name || null,
		priority: f.priority?.name || null,
		type: f.issuetype?.name || null,
		requestType: requestType(f),
		assignee: f.assignee?.displayName || null,
		reporter: f.reporter?.displayName || null,
		labels: f.labels || [],
		components: (f.components || []).map((c) => c.name),
		sprint: extractSprint(f),
		storyPoints: extractStoryPoints(f),
		created: f.created,
		updated: f.updated,
		description: descriptionText(f.description),
		...standardJson(f),
		...(extra && { fields: extra }),
	};
}

export function curateCommentsJson(comments) {
	return comments.map((c) => ({
		id: c.id,
		author: c.author?.displayName || null,
		date: c.created,
		body: richText(c.body),
	}));
}

// Server pages by startAt and reports a total; Cloud pages by token.
export function curateSearchJson(result) {
	return {
		...(result.total !== undefined && { total: result.total }),
		...(result.nextPageToken !== undefined && { nextPageToken: result.nextPageToken, isLast: result.isLast }),
		...(result.queue && { queue: { id: result.queue.id, name: result.queue.name, jql: result.queue.jql } }),
		issues: result.issues.map((issue) => ({
			key: issue.key,
			summary: issue.fields.summary,
			status: issue.fields.status?.name || null,
			assignee: issue.fields.assignee?.displayName || null,
			priority: issue.fields.priority?.name || null,
			updated: issue.fields.updated,
		})),
	};
}

export function curateChildrenJson(result) {
	return {
		parent: result.parent,
		source: result.source,
		total: result.total,
		issues: result.issues.map((issue) => ({
			key: issue.key,
			summary: issue.fields?.summary || null,
			status: issue.fields?.status?.name || null,
			type: issue.fields?.issuetype?.name || null,
			assignee: issue.fields?.assignee?.displayName || null,
			priority: issue.fields?.priority?.name || null,
			updated: issue.fields?.updated || null,
		})),
	};
}

// --- Plain formatters ---

export function plainIssueView(issue, extra) {
	const f = issue.fields;
	console.log(`${issue.key} ${f.summary}`);
	console.log(`Status: ${f.status?.name || 'Unknown'}`);
	console.log(`Priority: ${f.priority?.name || 'None'}`);
	console.log(`Type: ${f.issuetype?.name || 'Unknown'}`);
	const rt = requestType(f);
	if (rt) console.log(`Request Type: ${rt}`);
	console.log(`Assignee: ${f.assignee?.displayName || 'Unassigned'}`);
	console.log(`Reporter: ${f.reporter?.displayName || 'Unknown'}`);
	if (f.labels?.length > 0) console.log(`Labels: ${f.labels.join(', ')}`);
	if (f.components?.length > 0) console.log(`Components: ${f.components.map((c) => c.name).join(', ')}`);
	const sprint = extractSprint(f);
	if (sprint) console.log(`Sprint: ${sprint}`);
	const points = extractStoryPoints(f);
	if (points) console.log(`Story Points: ${points}`);
	plainExtras(f, extra);
	console.log(`Created: ${f.created}`);
	console.log(`Updated: ${f.updated}`);
	const desc = descriptionText(f.description);
	if (desc) console.log(`Description:\n${desc.trim()}`);
}

export function plainIssueComments(comments) {
	if (comments.length === 0) { console.log('No comments.'); return; }
	for (const c of comments) {
		const body = richText(c.body);
		console.log(`#${c.id} ${c.author?.displayName || 'Unknown'} (${relativeTime(c.created)}): ${body.trim()}`);
	}
}

export function plainIssueSearch(result) {
	if (result.queue) {
		console.log(`Queue: ${result.queue.name} (${result.queue.id})`);
		console.log(`JQL: ${result.queue.jql}`);
	}
	if (result.issues.length === 0) { console.log('No issues found.'); return; }
	for (const issue of result.issues) {
		const f = issue.fields;
		console.log(`${issue.key} [${f.status?.name}] "${f.summary}" - ${f.assignee?.displayName || 'Unassigned'} (${f.priority?.name}, ${relativeTime(f.updated)})`);
	}
	const showing = result.startAt + result.issues.length;
	if (result.total > showing) console.log(`Showing ${result.startAt + 1}-${showing} of ${result.total}`);
	if (!result.isLast && result.nextPageToken) console.log(`More results available (nextPageToken: ${result.nextPageToken})`);
}

export function plainIssueChildren(result) {
	const label = result.source === 'epic' ? 'epic children' : 'subtasks';
	console.log(`${result.parent.key} (${result.parent.type}) "${result.parent.summary}" - ${result.total} ${label}`);
	if (result.issues.length === 0) { console.log('None.'); return; }
	for (const issue of result.issues) {
		const f = issue.fields || {};
		const parts = [
			`${issue.key}`,
			f.status?.name ? `[${f.status.name}]` : null,
			f.issuetype?.name ? `(${f.issuetype.name})` : null,
			f.summary ? `"${f.summary}"` : null,
		].filter(Boolean);
		const meta = [
			f.assignee?.displayName || null,
			f.priority?.name || null,
			f.updated ? relativeTime(f.updated) : null,
		].filter(Boolean).join(', ');
		console.log(`${parts.join(' ')}${meta ? ` - ${meta}` : ''}`);
	}
}

// --- Rich formatters (original) ---

export function formatIssueView(issue, extra) {
	const f = issue.fields;

	heading(`${issue.key} ${f.summary}`);
	divider();
	field('Status', statusColor(f.status?.name));
	field('Priority', priorityColor(f.priority?.name));
	field('Type', f.issuetype?.name);
	field('Request Type', requestType(f));
	field('Assignee', f.assignee?.displayName || pc.dim('Unassigned'));
	field('Reporter', f.reporter?.displayName);
	field('Labels', f.labels?.length > 0 ? f.labels.join(', ') : null);
	field('Components', f.components?.map((c) => c.name).join(', ') || null);

	const sprint = extractSprint(f);
	if (sprint) field('Sprint', sprint);

	const points = extractStoryPoints(f);
	if (points) field('Story Points', points);

	richExtras(f, extra);
	field('Created', new Date(f.created).toLocaleString());
	field('Updated', new Date(f.updated).toLocaleString());

	if (f.description) {
		heading('Description');
		const desc = descriptionText(f.description);
		const lines = desc.trim().split('\n');
		const truncated = lines.slice(0, 30);
		for (const line of truncated) {
			console.log(`  ${line}`);
		}
		if (lines.length > 30) {
			console.log(pc.dim(`  ... (${lines.length - 30} more lines)`));
		}
	}

	console.log('');
}

export function formatIssueComments(comments) {
	if (comments.length === 0) {
		console.log(pc.dim('  No comments.'));
		return;
	}

	for (const c of comments) {
		console.log(`\n  ${pc.bold(c.author?.displayName || 'Unknown')} ${pc.dim(`${relativeTime(c.created)} #${c.id}`)}`);
		if (c.body) {
			const lines = richText(c.body).trim().split('\n');
			for (const line of lines) {
				console.log(`  ${line}`);
			}
		}
	}
	console.log('');
}

export function formatIssueSearch(result) {
	const { issues, total, startAt } = result;

	if (result.queue) {
		heading(`Queue: ${result.queue.name}`);
		console.log(pc.dim(`  ${result.queue.jql}`));
		divider();
	}

	if (issues.length === 0) {
		console.log(pc.dim('  No issues found.'));
		return;
	}

	const rows = issues.map((issue) => [
		pc.bold(issue.key),
		(issue.fields.summary || '').length > 55
			? issue.fields.summary.slice(0, 52) + '...'
			: issue.fields.summary || '',
		statusColor(issue.fields.status?.name),
		issue.fields.assignee?.displayName || pc.dim('Unassigned'),
		priorityColor(issue.fields.priority?.name),
		relativeTime(issue.fields.updated),
	]);

	console.log(table(['Key', 'Summary', 'Status', 'Assignee', 'Priority', 'Updated'], rows));

	const showing = startAt + issues.length;
	if (total > showing) {
		console.log(pc.dim(`  Showing ${startAt + 1}-${showing} of ${total} results`));
	}
	if (!result.isLast && result.nextPageToken) {
		console.log(pc.dim(`  More results available — pass --next ${result.nextPageToken} to continue`));
	}
	console.log('');
}

export function formatIssueChildren(result) {
	const { issues, parent, source } = result;
	const label = source === 'epic' ? 'children' : 'subtasks';

	heading(`${parent.key} ${parent.summary}`);
	console.log(pc.dim(`  ${parent.type} · ${result.total} ${label}`));
	divider();

	if (issues.length === 0) {
		console.log(pc.dim('  None.'));
		console.log('');
		return;
	}

	const rows = issues.map((issue) => {
		const f = issue.fields || {};
		return [
			pc.bold(issue.key),
			(f.summary || '').length > 50
				? f.summary.slice(0, 47) + '...'
				: f.summary || '',
			f.issuetype?.name || pc.dim('—'),
			statusColor(f.status?.name),
			f.assignee?.displayName || pc.dim('Unassigned'),
			priorityColor(f.priority?.name),
			f.updated ? relativeTime(f.updated) : pc.dim('—'),
		];
	});

	console.log(table(['Key', 'Summary', 'Type', 'Status', 'Assignee', 'Priority', 'Updated'], rows));
	console.log('');
}

// --- Service Desk queues ---

export function curateQueuesJson(queues) {
	return queues.map((q) => ({ id: q.id, name: q.name, jql: q.jql }));
}

export function plainQueueList(queues) {
	if (queues.length === 0) { console.log('No queues.'); return; }
	for (const q of queues) {
		console.log(`${q.id}\t${q.name}\t${q.jql}`);
	}
}

export function formatQueueList(queues) {
	if (queues.length === 0) {
		console.log(pc.dim('  No queues.'));
		return;
	}
	const rows = queues.map((q) => [
		pc.dim(String(q.id)),
		pc.bold(q.name),
		(q.jql || '').length > 80 ? q.jql.slice(0, 77) + '...' : q.jql || '',
	]);
	console.log(table(['ID', 'Name', 'JQL'], rows));
	console.log('');
}
