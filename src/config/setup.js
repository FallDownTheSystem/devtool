import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
	types, settings, setting, label, listConnections, isDefault, saveConnection, validateName, resolveIndex, fieldProblem, storeSecret,
} from './store.js';
import { lookupSecret } from './secrets.js';

function secretOf(connection, key) {
	return lookupSecret(connection, label(connection), key).value;
}

function confirm(value) {
	if (p.isCancel(value)) {
		p.cancel('Setup cancelled.');
		process.exit(0);
	}
	return value;
}

function answer(value) {
	return (confirm(value) ?? '').trim();
}

export function describe(connections, index) {
	const connection = connections[index];
	const { title } = types[connection.type];
	const sameType = connections.filter((c) => c.type === connection.type).length;
	const marker = sameType > 1 && isDefault(connections, index) ? ', default' : '';
	return `${label(connection)} (${title}${marker})`;
}

async function chooseType() {
	return answer(await p.select({
		message: 'Connection type',
		options: Object.entries(types).map(([value, { title }]) => ({ value, label: title })),
	}));
}

// Service Desk Cloud often shares an Atlassian account with Confluence Cloud.
async function reusableCredentials(connections) {
	const sources = connections.filter((c) => c.type === 'confluence' && c.email && secretOf(c, 'token'));
	if (!sources.length) return null;
	const choice = answer(await p.select({
		message: 'Service Desk credentials',
		options: [
			...sources.map((c) => ({ value: label(c), label: `Reuse email and token from Confluence connection "${label(c)}"` })),
			{ value: '', label: 'Enter new credentials' },
		],
	}));
	const source = sources.find((c) => label(c) === choice);
	return source ? { email: source.email, token: secretOf(source, 'token') } : null;
}

async function promptConnection(type, existing = {}, index = -1) {
	const connections = listConnections();
	const connection = { type };
	if (existing.default) connection.default = true;
	if (types[type].note) p.note(types[type].note, types[type].title);

	const unnamedTaken = connections.some((c, i) => i !== index && c.type === type && !c.name);
	connection.name = answer(await p.text({
		message: unnamedTaken ? 'Connection name' : 'Connection name (optional)',
		placeholder: unnamedTaken ? 'work' : `leave empty to refer to it as "${type}"`,
		initialValue: existing.name || '',
		validate: (v) => validateName(connections, { type, name: (v ?? '').trim() }, index),
	}));

	const reused = type === 'serviceDesk' ? await reusableCredentials(connections) : null;

	// New secrets go to the OS credential store when the user chooses it, after the connection is saved.
	const secrets = {};
	const storeOrKeep = async (key, value) => {
		const inStore = confirm(await p.confirm({ message: 'Save the token in the OS credential store instead of the config file?', initialValue: true }));
		if (inStore) secrets[key] = value;
		else connection[key] = value;
	};

	for (const [key, field] of Object.entries(types[type].fields)) {
		if (reused && (key === 'email' || key === 'token')) {
			if (field.secret) await storeOrKeep(key, reused[key]);
			else connection[key] = reused[key];
			continue;
		}
		// A secret kept in the credential store or the environment stays there.
		const keep = field.secret && (existing[key] || (existing.type && secretOf(existing, key)));
		const message = keep ? `${field.message} (leave empty to keep the current one)` : field.message;
		const validate = (v) => {
			const value = (v ?? '').trim();
			if (!value) return field.required && !keep ? 'Required' : undefined;
			return fieldProblem(type, key, value);
		};
		const value = field.secret
			? answer(await p.password({ message, validate }))
			: answer(await p.text({ message, placeholder: field.placeholder, initialValue: existing[key] || '', validate }));
		if (field.secret && value) await storeOrKeep(key, value);
		else connection[key] = value || (keep ? existing[key] ?? '' : '');
	}

	if (types[type].writeTarget) {
		connection.allowWrite = confirm(await p.confirm({
			message: settings.allowWrite.message,
			initialValue: setting(existing, 'allowWrite'),
		}));
		connection.requireApproval = connection.allowWrite
			? confirm(await p.confirm({ message: settings.requireApproval.message, initialValue: setting(existing, 'requireApproval') }))
			: setting(existing, 'requireApproval');
	}

	saveConnection(connection, index);
	for (const [key, value] of Object.entries(secrets)) {
		try {
			storeSecret(label(connection), key, value);
		} catch (err) {
			p.log.warn(`${err.message}\nThe connection was saved without its ${key}. Run \`dev config token ${label(connection)}\` to try again, or \`dev config set ${label(connection)}.${key} <value>\` to keep it in the config file.`);
		}
	}
	return connection;
}

export async function addConnection(type, name) {
	p.intro(pc.cyan('Add a connection'));
	const connection = await promptConnection(type || await chooseType(), { name });
	p.outro(pc.green(`Saved connection "${label(connection)}"`));
}

export async function editConnection(ref) {
	const index = resolveIndex(ref);
	const existing = listConnections()[index];
	p.intro(pc.cyan(`Edit connection "${label(existing)}"`));
	const connection = await promptConnection(existing.type, existing, index);
	p.outro(pc.green(`Saved connection "${label(connection)}"`));
}

export async function runSetup() {
	p.intro(pc.cyan('DevTool Setup'));
	for (;;) {
		const connections = listConnections();
		const choice = answer(await p.select({
			message: connections.length ? 'Edit a connection, or add a new one' : 'No connections configured yet',
			options: [
				...connections.map((_, i) => ({ value: String(i), label: `Edit ${describe(connections, i)}` })),
				{ value: 'add', label: 'Add a connection' },
				{ value: 'done', label: 'Done' },
			],
		}));
		if (choice === 'done') break;
		if (choice === 'add') await promptConnection(await chooseType());
		else await promptConnection(connections[choice].type, connections[choice], Number(choice));
	}
	p.outro(pc.green('Configuration saved!'));
}
