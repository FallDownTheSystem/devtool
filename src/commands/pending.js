import { Command } from 'commander';
import { getConnection } from '../config/store.js';
import { listPending, getPending, claimPending, restorePending } from '../config/pending.js';
import { actions } from '../actions/index.js';
import { assertWritable, assertSameTarget, execute, pendingJson, printDetails } from '../utils/write.js';
import { table, heading, success, warn, pc } from '../utils/output.js';
import { handleError } from '../utils/errors.js';
import { getOutputMode, outputJson } from '../utils/mode.js';

// An entry written by another version of devtool can name an action this one lacks; it can still be listed and rejected.
function actionOf(entry) {
	return actions[entry.action] ?? {
		summary: () => `Unknown action ${entry.action}`,
		details: () => [],
	};
}

function describe(entry) {
	return pendingJson(entry, actionOf(entry));
}

const pending = new Command('pending')
	.description('Writes waiting for approval (connections with requireApproval)');

pending.command('list', { isDefault: true })
	.alias('ls')
	.description('List pending actions')
	.action(function () {
		const mode = getOutputMode(this);
		try {
			const entries = listPending().map(describe);
			if (mode === 'json') {
				outputJson(entries);
			} else if (!entries.length) {
				console.log(mode === 'rich' ? pc.dim('  No pending actions.') : 'No pending actions.');
			} else if (mode === 'plain') {
				for (const e of entries) console.log(`${e.id} [${e.connection}] ${e.summary} (expires ${e.expiresAt})`);
			} else {
				console.log(table(['ID', 'Connection', 'Action', 'Expires'], entries.map((e) => [
					e.id, e.connection, e.summary, new Date(e.expiresAt).toLocaleString(),
				])));
			}
		} catch (err) {
			handleError(err, 'pending list');
		}
	});

pending.command('show <id>')
	.description('Show what a pending action will do')
	.action(function (id) {
		const mode = getOutputMode(this);
		try {
			const entry = getPending(id);
			const description = describe(entry);
			if (mode === 'json') {
				outputJson({ ...description, params: entry.params });
				return;
			}
			if (mode === 'rich') heading(`[${entry.id}] ${description.summary}`);
			else console.log(`[${entry.id}] ${description.summary}`);
			printDetails([['Connection', entry.connection], ...Object.entries(description.details), ['Expires', entry.expiresAt]], mode);
		} catch (err) {
			handleError(err, 'pending show');
		}
	});

pending.command('approve <id>')
	.description('Run a pending action. Only after the user approved it')
	.action(async function (id) {
		const mode = getOutputMode(this);
		let entry;
		let sent = false;
		try {
			entry = claimPending(id);
			const action = actions[entry.action];
			if (!action) throw new Error(`Unknown action "${entry.action}". It was created by another version of devtool.`);
			const connection = getConnection(action.type, entry.connection);
			assertWritable(connection);
			assertSameTarget(connection, entry);
			if (action.verify) await action.verify(connection, entry.params);
			sent = true;
			await execute(action, connection, entry.params, mode);
		} catch (err) {
			handleError(err, err.url || entry?.action || 'pending approve');
			if (!entry) return;
			// A 4xx means the server refused the request, and a refused connection means it was never
			// delivered, so nothing changed and a retry is safe. A 5xx or a lost response can follow an
			// applied write, and keeping the action would allow a duplicate.
			const code = err.code ?? err.cause?.code;
			const refused = err.status >= 400 && err.status < 500;
			if (!sent || refused || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
				restorePending(entry);
				// A changed target or a version conflict fails again on every retry of the same parameters.
				warn(err.stale || err.status === 409
					? `Action ${entry.id} is still pending, but its target changed after the preview. Reject it and request it again.`
					: `Action ${entry.id} is still pending. Fix the cause and approve it again, or reject it.`);
			} else {
				warn(`The outcome of action ${entry.id} is unknown, so it was removed. Check the target before you request it again.`);
			}
		}
	});

pending.command('reject <id>')
	.alias('discard')
	.description('Discard a pending action without running it')
	.action(function (id) {
		const mode = getOutputMode(this);
		try {
			const description = describe(claimPending(id));
			if (mode === 'json') outputJson({ status: 'rejected', ...description });
			else if (mode === 'plain') console.log(`Rejected ${description.id}: ${description.summary}`);
			else success(`Rejected ${description.id}: ${description.summary}`);
		} catch (err) {
			handleError(err, 'pending reject');
		}
	});

export default pending;
