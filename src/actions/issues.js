import { richText } from '../utils/markup.js';
import { requireText } from './require.js';

// Builds the issue actions of a Jira dialect. Jira Server takes wiki-markup strings and user names;
// Jira Cloud (Service Desk) takes ADF and account IDs. `dialect` supplies:
//   prefix, type     action name prefix and connection type
//   client           module with getIssue, getComment, getTransitions, createIssue, editIssue,
//                    deleteIssue, transitionIssue, addComment, updateComment, deleteComment
//   text, user       map plain text and a user reference to API field values
//   publicComments   whether a new comment can be customer-visible
export function issueActions({ prefix, type, client, text, user, publicComments = false }) {
	function fields(params) {
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
	// then describe a request other than the one sent.
	function rejectOverlap(params) {
		const named = Object.keys(fields({ ...params, fields: {} }));
		const overlap = Object.keys(params.fields || {}).filter((key) => named.includes(key));
		if (overlap.length) throw new Error(`--field ${overlap.join(', ')} repeats a dedicated option; use only one of them.`);
		return params;
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
		for (const [key, value] of Object.entries(params.fields || {})) details.push([key, JSON.stringify(value)]);
		if (params.description !== undefined) details.push(['Description', params.description || '(empty)']);
		return details;
	}

	async function currentComment(connection, { key, id }) {
		const comment = await client.getComment(connection, key, id);
		return { author: comment.author?.displayName || 'Unknown', current: richText(comment.body) };
	}

	async function currentIssue(connection, { key }) {
		const issue = await client.getIssue(connection, key);
		return { currentSummary: issue.fields?.summary, subtasks: (issue.fields?.subtasks || []).length };
	}

	const create = {
		name: `${prefix}.issue.create`,
		type,
		async prepare(connection, input) {
			// A --field project or issuetype (e.g. by ID) replaces the defaults instead of colliding with them.
			const given = input.fields || {};
			const project = given.project ? input.project : input.project || connection.defaultProject;
			if (!project && !given.project) throw new Error('No project specified. Pass --project <key> or set defaultProject on the connection.');
			if (!input.summary) throw new Error('A summary is required. Pass --summary <text>.');
			const issueType = given.issuetype ? input.issueType : input.issueType || 'Task';
			return rejectOverlap({ ...input, project, issueType });
		},
		summary: (p) => `Create ${p.issueType ? `a ${p.issueType}` : 'an issue'} in ${p.project || 'the --field project'}: ${p.summary}`,
		details: fieldDetails,
		run: (connection, p) => client.createIssue(connection, fields(p)),
		report: (issue) => ({ message: `Created ${issue.key}`, json: { key: issue.key, id: issue.id } }),
	};

	const edit = {
		name: `${prefix}.issue.edit`,
		type,
		async prepare(connection, input) {
			if (!Object.keys(fields(input)).length) {
				throw new Error('Nothing to change. Pass at least one field option, such as --summary or --field.');
			}
			return rejectOverlap(input);
		},
		preview: currentIssue,
		summary: (p) => `Edit ${p.key}`,
		details: (p) => [['Issue', `${p.key} (${p.currentSummary})`], ...fieldDetails(p)],
		run: (connection, p) => client.editIssue(connection, p.key, fields(p)),
		report: (_, p) => ({ message: `Updated ${p.key}`, json: { key: p.key } }),
	};

	const remove = {
		name: `${prefix}.issue.delete`,
		type,
		preview: currentIssue,
		summary: (p) => `Delete ${p.key}`,
		details: (p) => [
			['Issue', `${p.key} (${p.currentSummary})`],
			['Subtasks', p.subtasks ? `${p.subtasks}${p.deleteSubtasks ? ', deleted with the issue' : ''}` : 'none'],
		],
		run: (connection, p) => client.deleteIssue(connection, p.key, p.deleteSubtasks),
		report: (_, p) => ({ message: `Deleted ${p.key}`, json: { key: p.key } }),
	};

	// The transition is resolved to an ID when the action is prepared, so approval shows the exact target status.
	const transition = {
		name: `${prefix}.issue.transition`,
		type,
		async prepare(connection, input) {
			const transitions = await client.getTransitions(connection, input.key);
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
		run: (connection, p) => client.transitionIssue(connection, p.key, p.transitionId),
		report: (_, p) => ({ message: `Moved ${p.key} to ${p.toStatus || p.transitionName}`, json: { key: p.key, status: p.toStatus || null } }),
	};

	const commentAdd = {
		name: `${prefix}.comment.add`,
		type,
		async prepare(connection, input) {
			requireText(input.body, 'comment');
			return input;
		},
		summary: (p) => `Add ${publicComments ? (p.isPublic ? 'a public reply' : 'an internal comment') : 'a comment'} to ${p.key}`,
		details: (p) => [
			['Issue', p.key],
			...(publicComments ? [['Visibility', p.isPublic ? 'public: the customer sees it' : 'internal: agents only']] : []),
			['Comment', p.body],
		],
		run: (connection, p) => client.addComment(connection, p.key, p.body, { isPublic: p.isPublic }),
		report: (comment, p) => ({ message: `Added comment ${comment.id} to ${p.key}`, json: { key: p.key, id: String(comment.id) } }),
	};

	const commentEdit = {
		name: `${prefix}.comment.edit`,
		type,
		async prepare(connection, input) {
			requireText(input.body, 'comment');
			return input;
		},
		preview: currentComment,
		summary: (p) => `Edit comment ${p.id} on ${p.key}`,
		details: (p) => [['Issue', p.key], ['Current text', p.current], ['New text', p.body]],
		run: (connection, p) => client.updateComment(connection, p.key, p.id, text(p.body)),
		report: (_, p) => ({ message: `Updated comment ${p.id} on ${p.key}`, json: { key: p.key, id: String(p.id) } }),
	};

	const commentDelete = {
		name: `${prefix}.comment.delete`,
		type,
		preview: currentComment,
		summary: (p) => `Delete comment ${p.id} on ${p.key}`,
		details: (p) => [['Issue', p.key], ['Author', p.author], ['Comment', p.current]],
		run: (connection, p) => client.deleteComment(connection, p.key, p.id),
		report: (_, p) => ({ message: `Deleted comment ${p.id} on ${p.key}`, json: { key: p.key, id: String(p.id) } }),
	};

	return { create, edit, remove, transition, commentAdd, commentEdit, commentDelete };
}
