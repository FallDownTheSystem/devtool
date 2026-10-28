import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import {
	types, settings, setting, settingKeys, label, listConnections, removeConnection, setDefault, setField, configPath,
	resolveIndex, secretFields, storeSecret, deleteStoredSecret,
} from '../config/store.js';
import { lookupSecret, envName, SERVICE } from '../config/secrets.js';
import { runSetup, addConnection, editConnection, describe } from '../config/setup.js';
import { heading, field, mask, success, error, divider } from '../utils/output.js';

function attempt(action) {
	return async (...args) => {
		try {
			await action(...args);
		} catch (err) {
			error(err.message);
			process.exitCode = 1;
		}
	};
}

function parseType(input) {
	if (input === undefined) return undefined;
	const type = Object.keys(types).find((t) => t.toLowerCase() === input.toLowerCase());
	if (!type) throw new Error(`Unknown connection type "${input}". Valid types: ${Object.keys(types).join(', ')}`);
	return type;
}

const SOURCES = { config: 'config file', env: 'environment', store: 'credential store' };

function secretText(connection, key) {
	const { value, source, error } = lookupSecret(connection, label(connection), key);
	if (value) return `${mask(value)} (${source === 'env' ? `environment ${envName(label(connection), key)}` : SOURCES[source]})`;
	return error ? '(not set; the credential store could not be read)' : '(not set)';
}

// A token typed at a hidden prompt, or read from standard input so it stays out of the shell history.
async function readToken(name) {
	if (!process.stdin.isTTY) return readFileSync(0, 'utf8').replace(/\r?\n$/, '');
	const value = await p.password({ message: `Token for connection "${name}"` });
	if (p.isCancel(value)) throw new Error('Cancelled; nothing was stored.');
	return value;
}

const config = new Command('config')
	.description('Manage connections');

config
	.command('setup')
	.description('Add or edit connections interactively')
	.action(attempt(runSetup));

config
	.command('add [type]')
	.description(`Add a connection (${Object.keys(types).join(', ')})`)
	.option('-n, --name <name>', 'Connection name')
	.action(attempt((type, opts) => addConnection(parseType(type), opts.name)));

config
	.command('edit <connection>')
	.description('Edit a connection interactively')
	.action(attempt(editConnection));

config
	.command('remove <connection>')
	.alias('rm')
	.description('Remove a connection')
	.action(attempt((ref) => {
		success(`Removed connection "${label(removeConnection(ref))}"`);
	}));

config
	.command('default <connection>')
	.description('Use a connection when no --connection is given for its type')
	.action(attempt((ref) => {
		const connection = setDefault(ref);
		success(`"${label(connection)}" is now the default ${types[connection.type].title} connection`);
	}));

config
	.command('show')
	.aliases(['get', 'list'])
	.description('Show all connections')
	.action(() => {
		const connections = listConnections();
		if (!connections.length) {
			console.log('\nNo connections configured. Run `dev config add` to add one.');
		}

		connections.forEach((connection, index) => {
			heading(describe(connections, index));
			for (const [key, property] of Object.entries(types[connection.type].fields)) {
				if (property.secret) {
					field(property.title, secretText(connection, key));
					continue;
				}
				field(property.title, connection[key] ?? '');
			}
			for (const key of settingKeys(connection.type)) {
				field(settings[key].title, setting(connection, key) ? 'yes' : 'no');
			}
		});

		console.log('');
		divider();
		field('Config file', configPath());
		console.log('');
	});

config
	.command('set <key> <value>')
	.description('Set a connection field, as <connection>.<field> (e.g. bitbucket.workspace my-ws, jira.allowWrite true)')
	.action(attempt((key, value) => {
		const dot = key.lastIndexOf('.');
		if (dot <= 0) throw new Error(`Invalid key: ${key}. Use <connection>.<field>, e.g. jira.baseUrl`);
		const connection = setField(key.slice(0, dot), key.slice(dot + 1), value);
		success(`Set ${key.slice(dot + 1)} on connection "${label(connection)}"`);
	}));

config
	.command('token <connection>')
	.description('Store the token of a connection in the OS credential store (Windows Credential Manager, macOS Keychain, Linux Secret Service)')
	.option('--move', 'Move the token in the config file to the credential store')
	.option('--remove', 'Remove the token from the credential store')
	.addHelpText('after', `
Without an option, the token is read from a hidden prompt, or from standard input when it is piped:
  dev config token work
  op read op://vault/jira/token | dev config token work

A token is looked up in the config file first, then in DEV_<CONNECTION>_TOKEN (e.g. DEV_WORK_TOKEN),
then in the credential store under service "${SERVICE}", account "<connection>.token". Storing a token
removes it from the config file, which would otherwise take precedence. Renaming a connection moves
its entry; removing the connection deletes it.`)
	.action(attempt(async (ref, opts) => {
		if (opts.move && opts.remove) throw new Error('Give --move or --remove, not both.');
		const connection = listConnections()[resolveIndex(ref)];
		const name = label(connection);
		if (!secretFields(connection.type).includes('token')) {
			throw new Error(`A ${types[connection.type].title} connection has no token.${connection.type === 'graph' ? ' It signs in with `dev graph login`.' : ''}`);
		}
		if (opts.remove) {
			const { deleted } = deleteStoredSecret(ref, 'token');
			success(deleted ? `Removed the token of "${name}" from the credential store` : `The credential store had no token for "${name}"`);
			return;
		}
		const value = opts.move ? undefined : await readToken(name);
		if (!opts.move && !value?.trim()) throw new Error('The token is empty; nothing was stored.');
		const result = storeSecret(ref, 'token', value?.trim());
		success(`Stored the token of "${name}" in the credential store (service "${SERVICE}", account "${result.account}")`);
		if (result.removedFromConfig) success('Removed the token from the config file');
		if (process.env[envName(name, 'token')]) console.log(`Note: ${envName(name, 'token')} is set and is used before the credential store.`);
	}));

export default config;
