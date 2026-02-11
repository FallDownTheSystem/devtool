import { table, heading, field, divider, pc } from '../utils/output.js';

function stateLabel(state, draft) {
	if (draft) return pc.yellow('DRAFT');
	switch (state) {
		case 'OPEN': return pc.green(state);
		case 'MERGED': return pc.blue(state);
		case 'DECLINED': return pc.red(state);
		case 'SUPERSEDED': return pc.dim(state);
		default: return state;
	}
}

function stateText(state, draft) {
	return draft ? 'DRAFT' : state;
}

function approvalStatus(participant) {
	if (participant.approved) return pc.green('APPROVED');
	if (participant.state === 'changes_requested') return pc.red('CHANGES REQUESTED');
	return pc.dim('PENDING');
}

function approvalStatusText(participant) {
	if (participant.approved) return 'APPROVED';
	if (participant.state === 'changes_requested') return 'CHANGES_REQUESTED';
	return 'PENDING';
}

function approvalCount(pr) {
	const approved = (pr.participants || []).filter((p) => p.approved).length;
	const total = (pr.participants || []).filter((p) => p.role === 'REVIEWER').length;
	if (total === 0) return pc.dim('0');
	if (approved === total) return pc.green(`${approved}/${total}`);
	return `${approved}/${total}`;
}

function approvalNumbers(pr) {
	const approved = (pr.participants || []).filter((p) => p.approved).length;
	const total = (pr.participants || []).filter((p) => p.role === 'REVIEWER').length;
	return { approved, total };
}

function relativeTime(dateStr) {
	const diff = Date.now() - new Date(dateStr).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(dateStr).toLocaleDateString();
}

function reviewers(pr) {
	return (pr.participants || []).filter((p) => p.role === 'REVIEWER');
}

// --- JSON curators ---

export function curateListJson(prs) {
	return prs.map((pr) => {
		const { approved, total } = approvalNumbers(pr);
		return {
			id: pr.id,
			title: pr.title,
			author: pr.author.display_name,
			state: pr.state,
			draft: pr.draft || false,
			approvals: { approved, total },
			source: pr.source.branch.name,
			destination: pr.destination.branch.name,
			updated: pr.updated_on,
		};
	});
}

export function curateViewJson(pr) {
	return {
		id: pr.id,
		title: pr.title,
		state: pr.state,
		draft: pr.draft || false,
		author: pr.author.display_name,
		source: pr.source.branch.name,
		destination: pr.destination.branch.name,
		created: pr.created_on,
		updated: pr.updated_on,
		description: pr.description || '',
		reviewers: reviewers(pr).map((r) => ({
			name: r.user.display_name,
			status: approvalStatusText(r),
		})),
	};
}

export function curateCommentsJson(comments) {
	return comments
		.filter((c) => !c.deleted)
		.sort((a, b) => new Date(a.created_on) - new Date(b.created_on))
		.map((c) => ({
			author: c.user.display_name,
			date: c.created_on,
			content: c.content?.raw || '',
			inline: c.inline ? { path: c.inline.path, line: c.inline.from || c.inline.to } : null,
		}));
}

export function curateDiffstatJson(files) {
	return files.map((f) => ({
		file: f.new?.path || f.old?.path || null,
		status: f.status,
		added: f.lines_added || 0,
		removed: f.lines_removed || 0,
	}));
}

export function curateActivityJson(activities) {
	return activities.map((a) => {
		if (a.approval) return { type: 'approval', user: a.approval.user.display_name, date: a.approval.date };
		if (a.update) return { type: 'update', user: a.update.author?.display_name, date: a.update.date, state: a.update.state };
		if (a.comment) return { type: 'comment', user: a.comment.user.display_name, date: a.comment.created_on, content: (a.comment.content?.raw || '').split('\n')[0] };
		if (a.changes_requested) return { type: 'changes_requested', user: a.changes_requested.user.display_name, date: a.changes_requested.date };
		return { type: 'unknown' };
	});
}

// --- Plain formatters ---

export function plainPrList(prs) {
	if (prs.length === 0) { console.log('No pull requests found.'); return; }
	for (const pr of prs) {
		const { approved, total } = approvalNumbers(pr);
		console.log(`#${pr.id} ${stateText(pr.state, pr.draft)} "${pr.title}" by ${pr.author.display_name} (${approved}/${total} approvals, ${relativeTime(pr.updated_on)})`);
	}
}

export function plainPrView(pr) {
	console.log(`#${pr.id} ${pr.title}`);
	console.log(`State: ${stateText(pr.state, pr.draft)}`);
	console.log(`Author: ${pr.author.display_name}`);
	console.log(`Source: ${pr.source.branch.name} -> ${pr.destination.branch.name}`);
	console.log(`Created: ${pr.created_on}`);
	console.log(`Updated: ${pr.updated_on}`);
	const revs = reviewers(pr);
	if (revs.length > 0) {
		console.log(`Reviewers: ${revs.map((r) => `${r.user.display_name} (${approvalStatusText(r)})`).join(', ')}`);
	}
	if (pr.description) {
		console.log(`Description:\n${pr.description.trim()}`);
	}
}

export function plainPrComments(comments) {
	const sorted = comments.filter((c) => !c.deleted).sort((a, b) => new Date(a.created_on) - new Date(b.created_on));
	if (sorted.length === 0) { console.log('No comments.'); return; }
	for (const c of sorted) {
		const inline = c.inline ? ` [${c.inline.path}:${c.inline.from || c.inline.to}]` : '';
		console.log(`${c.user.display_name} (${relativeTime(c.created_on)})${inline}: ${(c.content?.raw || '').trim()}`);
	}
}

export function plainPrDiffstat(files) {
	if (files.length === 0) { console.log('No file changes.'); return; }
	for (const f of files) {
		console.log(`${f.status} ${f.new?.path || f.old?.path} +${f.lines_added || 0} -${f.lines_removed || 0}`);
	}
	const added = files.reduce((s, f) => s + (f.lines_added || 0), 0);
	const removed = files.reduce((s, f) => s + (f.lines_removed || 0), 0);
	console.log(`${files.length} files changed, +${added}, -${removed}`);
}

export function plainPrActivity(activities) {
	if (activities.length === 0) { console.log('No activity.'); return; }
	for (const a of activities) {
		if (a.approval) console.log(`APPROVED by ${a.approval.user.display_name} (${relativeTime(a.approval.date)})`);
		else if (a.update) console.log(`UPDATED by ${a.update.author?.display_name || 'Unknown'} (${relativeTime(a.update.date)})${a.update.state ? ` -> ${a.update.state}` : ''}`);
		else if (a.comment) console.log(`COMMENT by ${a.comment.user.display_name} (${relativeTime(a.comment.created_on)}): ${(a.comment.content?.raw || '').split('\n')[0].slice(0, 80)}`);
		else if (a.changes_requested) console.log(`CHANGES_REQUESTED by ${a.changes_requested.user.display_name} (${relativeTime(a.changes_requested.date)})`);
	}
}

// --- Rich formatters (original) ---

export function formatPrList(prs) {
	if (prs.length === 0) {
		console.log(pc.dim('  No pull requests found.'));
		return;
	}

	const rows = prs.map((pr) => [
		pc.bold(`#${pr.id}`),
		pr.title.length > 60 ? pr.title.slice(0, 57) + '...' : pr.title,
		pr.author.display_name,
		stateLabel(pr.state, pr.draft),
		approvalCount(pr),
		relativeTime(pr.updated_on),
	]);

	console.log(table(['ID', 'Title', 'Author', 'State', 'Approvals', 'Updated'], rows));
}

export function formatPrView(pr) {
	heading(`#${pr.id} ${pr.title}`);
	divider();
	field('State', stateLabel(pr.state, pr.draft));
	field('Author', pr.author.display_name);
	field('Source', `${pr.source.branch.name} (${pr.source.repository?.full_name || ''})`);
	field('Destination', `${pr.destination.branch.name} (${pr.destination.repository?.full_name || ''})`);
	field('Created', new Date(pr.created_on).toLocaleString());
	field('Updated', new Date(pr.updated_on).toLocaleString());

	if (pr.description) {
		heading('Description');
		console.log(pr.description.trim());
	}

	const revs = reviewers(pr);
	if (revs.length > 0) {
		heading('Reviewers');
		for (const r of revs) {
			console.log(`  ${r.user.display_name}: ${approvalStatus(r)}`);
		}
	}

	console.log('');
}

export function formatPrComments(comments) {
	if (comments.length === 0) {
		console.log(pc.dim('  No comments.'));
		return;
	}

	const sorted = comments
		.filter((c) => !c.deleted)
		.sort((a, b) => new Date(a.created_on) - new Date(b.created_on));

	for (const c of sorted) {
		const inline = c.inline ? pc.dim(` [${c.inline.path}:${c.inline.from || c.inline.to}]`) : '';
		console.log(`\n  ${pc.bold(c.user.display_name)} ${pc.dim(relativeTime(c.created_on))}${inline}`);
		if (c.content?.raw) {
			const lines = c.content.raw.trim().split('\n');
			for (const line of lines) {
				console.log(`  ${line}`);
			}
		}
	}
	console.log('');
}

export function formatPrDiffstat(files) {
	if (files.length === 0) {
		console.log(pc.dim('  No file changes.'));
		return;
	}

	const rows = files.map((f) => {
		const added = f.lines_added || 0;
		const removed = f.lines_removed || 0;
		return [
			f.new?.path || f.old?.path || '(unknown)',
			f.status,
			pc.green(`+${added}`),
			pc.red(`-${removed}`),
		];
	});

	console.log(table(['File', 'Status', 'Added', 'Removed'], rows));

	const totalAdded = files.reduce((s, f) => s + (f.lines_added || 0), 0);
	const totalRemoved = files.reduce((s, f) => s + (f.lines_removed || 0), 0);
	console.log(`  ${files.length} files changed, ${pc.green(`+${totalAdded}`)}, ${pc.red(`-${totalRemoved}`)}`);
	console.log('');
}

export function formatPrActivity(activities) {
	if (activities.length === 0) {
		console.log(pc.dim('  No activity.'));
		return;
	}

	for (const a of activities) {
		if (a.approval) {
			const user = a.approval.user.display_name;
			const date = relativeTime(a.approval.date);
			console.log(`  ${pc.green('APPROVED')} by ${pc.bold(user)} ${pc.dim(date)}`);
		} else if (a.update) {
			const user = a.update.author?.display_name || 'Unknown';
			const date = relativeTime(a.update.date);
			const state = a.update.state ? ` → ${stateLabel(a.update.state, false)}` : '';
			console.log(`  ${pc.blue('UPDATED')} by ${pc.bold(user)} ${pc.dim(date)}${state}`);
		} else if (a.comment) {
			const user = a.comment.user.display_name;
			const date = relativeTime(a.comment.created_on);
			const snippet = (a.comment.content?.raw || '').split('\n')[0].slice(0, 80);
			console.log(`  ${pc.yellow('COMMENT')} by ${pc.bold(user)} ${pc.dim(date)}`);
			if (snippet) console.log(`    ${snippet}`);
		} else if (a.changes_requested) {
			const user = a.changes_requested.user.display_name;
			const date = relativeTime(a.changes_requested.date);
			console.log(`  ${pc.red('CHANGES REQUESTED')} by ${pc.bold(user)} ${pc.dim(date)}`);
		}
	}
	console.log('');
}
