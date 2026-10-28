import { readFileSync } from 'node:fs';
import { label, setting, types } from '../config/store.js';
import { addPending, getPending, claimPending, restorePending } from '../config/pending.js';
import { connectionFor } from './connection.js';
import { getOutputMode, outputJson } from './mode.js';
import { handleError } from './errors.js';
import { spinner, pc } from './output.js';

// Distinct from failure (1) so a script or agent can tell that nothing was sent and approval is needed.
const PENDING_EXIT_CODE = 2;

// An action is the unit that is held for approval and later run from its stored parameters:
//   name     registry key, e.g. 'jira.comment.add'
//   type     connection type, or a list of the types it works with
//   route    optional (input) => an issue or project key that picks the connection without --connection
//   prepare  optional (connection, input) => params; validates, resolves defaults, and reads what `run`
//            needs, so approval runs exactly the change that was shown
//   preview  optional (connection, params) => extra params; reads current state for the approval
//            preview only, so it runs only when the action is held
//   verify   optional (connection, params); runs on approval before anything is sent and throws when
//            the state the preview showed has changed
//   summary  (params) => one-line description
//   details  (params) => [label, text] pairs shown for approval
//   run      (connection, params) => result
//   report   (result, params) => { message, json }

export function assertWritable(connection) {
	if (!setting(connection, 'allowWrite')) {
		throw new Error(`Writes are disabled for the ${types[connection.type].title} connection "${label(connection)}". The user can enable them with \`dev config edit ${label(connection)}\`.`);
	}
}

// The site a connection writes to. A pending action records it because the label alone can resolve to
// another connection later: removing an unnamed connection makes its type label fall back to the default.
function target(connection) {
	return connection[types[connection.type].writeTarget];
}

export function assertSameTarget(connection, entry) {
	if (!entry.target || target(connection) !== entry.target) {
		throw new Error(`Connection "${entry.connection}" now points to ${target(connection) ?? 'nothing'}, not ${entry.target} as when the action was requested. Reject it and request it again.`);
	}
}

export const FILE_HELP = 'Read the text from a file ("-" for standard input)';

// Text arrives inline, or from a file or standard input ("-"), which keeps multi-line text out of shell quoting.
export function readText(text, file, flag = '--file') {
	if (text !== undefined && file !== undefined) throw new Error(`Give the text inline or with ${flag}, not both.`);
	if (file !== undefined) return readFileSync(file === '-' ? 0 : file, 'utf8');
	return text;
}

export function collect(value, previous = []) {
	return [...previous, value];
}

// `--field name=value` sets any API field by ID or display name. The value stays text here; the action
// converts it with the field's schema.
export function parseFieldArgs(entries = []) {
	const fields = {};
	for (const entry of entries) {
		const eq = entry.indexOf('=');
		if (eq <= 0) throw new Error(`Invalid --field "${entry}". Use <field>=<value>, e.g. customfield_10010=5 or "Story Points=5".`);
		fields[entry.slice(0, eq).trim()] = entry.slice(eq + 1);
	}
	return fields;
}

const EXCERPT_LENGTH = 2000;

function excerpt(text) {
	if (text.length <= EXCERPT_LENGTH) return text;
	return `${text.slice(0, EXCERPT_LENGTH)}\n… (${text.length - EXCERPT_LENGTH} more characters; \`dev pending show <id> --json\` shows all)`;
}

export function printDetails(details, mode) {
	for (const [name, value] of details) {
		const text = excerpt(String(value));
		const title = mode === 'rich' ? pc.dim(`${name}:`) : `${name}:`;
		if (text.includes('\n')) {
			console.log(`  ${title}`);
			for (const line of text.split('\n')) console.log(`    ${line}`);
		} else {
			console.log(`  ${title} ${text}`);
		}
	}
}

// A pending entry stores only the parameters; its description is derived from the action, so the two cannot disagree.
export function pendingJson(entry, action) {
	return {
		id: entry.id,
		action: entry.action,
		connection: entry.connection,
		summary: action.summary(entry.params),
		details: Object.fromEntries(action.details(entry.params)),
		createdAt: entry.createdAt,
		expiresAt: entry.expiresAt,
	};
}

function replacedNote(replaced) {
	return replaced ? `Replaced pending action ${replaced}; it can no longer be approved.` : undefined;
}

function reportPending(entry, action, mode, replaced) {
	const approve = `dev pending approve ${entry.id}`;
	const reject = `dev pending reject ${entry.id}`;
	const instruction = 'Nothing was sent. Show this action to the user and run the approve command only after the user approves it.';
	const changes = `If the user asks for changes, run the command again with the changes and add --replaces ${entry.id}.`;
	if (mode === 'json') {
		outputJson({
			status: 'pending_approval',
			...pendingJson(entry, action),
			message: `${instruction} ${changes}`,
			approve,
			reject,
			...(replaced && { replaced }),
		});
		return;
	}
	const heading = `Approval required [${entry.id}]: ${action.summary(entry.params)}`;
	console.log(mode === 'rich' ? pc.bold(pc.yellow(heading)) : heading);
	printDetails([['Connection', entry.connection], ...action.details(entry.params)], mode);
	if (replaced) console.log(replacedNote(replaced));
	console.log(instruction);
	console.log(changes);
	console.log(`Approve: ${approve}`);
	console.log(`Reject:  ${reject}`);
	console.log(`Expires: ${entry.expiresAt}`);
}

// Runs an action that is already authorized. Errors are thrown to the caller.
export async function execute(action, connection, params, mode, { replaced } = {}) {
	const s = mode === 'rich' ? spinner(`${action.summary(params)}...`).start() : null;
	let result;
	try {
		result = await action.run(connection, params);
	} catch (err) {
		if (s) s.error({ text: `Failed: ${action.summary(params)}` });
		throw err;
	}
	const { message, json } = action.report(result, params);
	if (s) s.success({ text: message });
	if (mode === 'json') {
		outputJson({ status: 'done', action: action.name, connection: label(connection), result: json, ...(replaced && { replaced }) });
		return;
	}
	if (mode === 'plain') console.log(message);
	if (replaced) console.log(replacedNote(replaced));
}

// Entry point for every write command: checks that the connection allows writes, then either runs the
// action (approval not required, or --approve given) or stores it as a pending action. `buildInput`
// turns the command options into the action input; its errors are reported like any other.
//
// --replaces <id> supersedes a pending action that the user asked to change. The old action is checked
// first, so a wrong ID stops the command, and it stays in place when the new write fails.
export async function runWrite(cmd, action, buildInput) {
	const mode = getOutputMode(cmd);
	const { approve, replaces } = cmd.optsWithGlobals();
	try {
		const input = buildInput();
		const connection = connectionFor(cmd, action.type, action.route?.(input));
		assertWritable(connection);
		if (replaces) getPending(replaces);
		let params = action.prepare ? await action.prepare(connection, input) : input;
		if (!setting(connection, 'requireApproval') || approve) {
			// Claimed before the request so the old action cannot be approved meanwhile; it was never sent,
			// so restoring it after any failure is safe.
			const old = replaces && claimPending(replaces);
			try {
				await execute(action, connection, params, mode, { replaced: old?.id });
			} catch (err) {
				if (old) restorePending(old);
				throw err;
			}
			return;
		}
		if (action.preview) params = { ...params, ...await action.preview(connection, params) };
		const entry = addPending({ action: action.name, connection: label(connection), target: target(connection), params });
		reportPending(entry, action, mode, replaces && claimPending(replaces).id);
		process.exitCode = PENDING_EXIT_CODE;
	} catch (err) {
		handleError(err, err.url || action.name);
	}
}
