import { Command } from 'commander';
import {
	types, settings, setting, settingKeys, label, listConnections, removeConnection, setDefault, setField, configPath,
} from '../config/store.js';
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
				const value = connection[key] ?? '';
				field(property.title, property.secret && value ? mask(value) : value);
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

export default config;
