import { table, pc } from '../utils/output.js';
import { hours } from '../actions/tempo.js';

const WORK_TYPE = '_WorkType_';

function days(worklogs) {
	const totals = new Map();
	for (const w of worklogs) totals.set(w.date, (totals.get(w.date) || 0) + w.seconds);
	return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, seconds]) => ({ date, seconds }));
}

const sum = (worklogs) => worklogs.reduce((total, w) => total + w.seconds, 0);

// Server Tempo reports no billable time, so the column appears only when a worklog has it.
const hasBillable = (worklogs) => worklogs.some((w) => w.billableSeconds !== null && w.billableSeconds !== undefined);

export function curateWorklogsJson({ from, to, worker, worklogs }) {
	return {
		from,
		to,
		worker,
		worklogs: worklogs.map((w) => ({
			id: w.id,
			date: w.date,
			start: w.start,
			key: w.issueKey,
			issueId: w.issueId,
			hours: Number(hours(w.seconds)),
			seconds: w.seconds,
			...(w.billableSeconds !== null && w.billableSeconds !== undefined && { billableHours: Number(hours(w.billableSeconds)) }),
			comment: w.comment,
			workType: w.attributes[WORK_TYPE] ?? null,
			attributes: w.attributes,
		})),
		days: days(worklogs).map((d) => ({ date: d.date, hours: Number(hours(d.seconds)), seconds: d.seconds })),
		totalHours: Number(hours(sum(worklogs))),
	};
}

export function plainWorklogs({ worklogs }) {
	const billable = hasBillable(worklogs);
	for (const w of worklogs) {
		const parts = [w.id, w.date, w.issueKey || w.issueId, hours(w.seconds)];
		if (billable) parts.push(`billable=${hours(w.billableSeconds ?? 0)}`);
		parts.push(w.attributes[WORK_TYPE] || '-');
		console.log(`${parts.join(' ')}${w.comment ? ` ${w.comment}` : ''}`);
	}
	for (const d of days(worklogs)) console.log(`${d.date} total ${hours(d.seconds)}`);
	if (worklogs.length) console.log(`total ${hours(sum(worklogs))}`);
}

export function formatWorklogs({ worklogs }) {
	if (!worklogs.length) {
		console.log(pc.dim('  No worklogs in this period.'));
		return;
	}
	const billable = hasBillable(worklogs);
	const head = ['ID', 'Date', 'Issue', 'Hours', ...(billable ? ['Billable'] : []), 'Work Type', 'Comment'];
	console.log(table(head, worklogs.map((w) => [
		w.id, w.date, w.issueKey || w.issueId || '', hours(w.seconds),
		...(billable ? [hours(w.billableSeconds ?? 0)] : []),
		w.attributes[WORK_TYPE] || '', w.comment,
	])));
	for (const d of days(worklogs)) console.log(`  ${pc.dim(d.date)}  ${pc.bold(`${hours(d.seconds)}h`)}`);
	console.log(`  ${pc.dim('Total     ')}  ${pc.bold(`${hours(sum(worklogs))}h`)}`);
}

function valuesText(attribute) {
	return attribute.values.map((v) => (v.name !== v.value ? `${v.value}  ${v.name}` : v.value)).join('\n');
}

export function plainAttributes(attributes) {
	for (const a of attributes) {
		console.log(`${a.key} ${a.name} (${[a.type, a.required && 'required'].filter(Boolean).join(', ')})`);
		for (const v of a.values) console.log(`  ${v.value}${v.name !== v.value ? ` ${v.name}` : ''}`);
	}
}

export function formatAttributes(attributes) {
	if (!attributes.length) {
		console.log(pc.dim('  No work attributes.'));
		return;
	}
	console.log(table(['Key', 'Name', 'Type', 'Required', 'Values'], attributes.map((a) => [
		a.key, a.name, a.type || '', a.required ? 'yes' : 'no', valuesText(a),
	])));
}
