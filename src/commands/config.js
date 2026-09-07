import { Command } from 'commander';
import { getAll, set, runSetup, configPath, schema } from '../config/store.js';
import { heading, field, mask, success, error, divider } from '../utils/output.js';

const config = new Command('config')
	.description('Manage configuration');

config
	.command('setup')
	.description('Run interactive setup')
	.action(async () => {
		await runSetup();
	});

config
	.command('show')
	.alias('get')
	.description('Show current configuration')
	.action(() => {
		const all = getAll();

		for (const [section, definition] of Object.entries(schema)) {
			heading(definition.title);
			for (const [key, property] of Object.entries(definition.properties)) {
				const value = all[section]?.[key] ?? '';
				field(property.title, property.writeOnly ? mask(value) : value);
			}
		}

		console.log('');
		divider();
		field('Config file', configPath());
		console.log('');
	});

config
	.command('set <key> <value>')
	.description('Set a config value (e.g. bitbucket.workspace my-ws)')
	.action((key, value) => {
		const validKeys = Object.entries(schema).flatMap(([section, definition]) =>
			Object.keys(definition.properties).map((key) => `${section}.${key}`));
		if (!validKeys.includes(key)) {
			error(`Invalid key: ${key}`);
			console.log(`Valid keys: ${validKeys.join(', ')}`);
			return;
		}
		set(key, value);
		success(`Set ${key}`);
	});

export default config;
