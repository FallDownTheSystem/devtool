import { Command } from 'commander';
import { getAll, set, runSetup, configPath, isConfigured } from '../config/store.js';
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
		if (!isConfigured()) {
			error('Not configured yet. Run: dev config setup');
			return;
		}

		const all = getAll();

		heading('Bitbucket');
		field('Workspace', all.bitbucket.workspace);
		field('Default repo', all.bitbucket.defaultRepo);
		field('Email', all.bitbucket.email);
		field('Token', mask(all.bitbucket.token));

		heading('Jira');
		field('Base URL', all.jira.baseUrl);
		field('Token', mask(all.jira.token));
		field('Default project', all.jira.defaultProject);

		heading('Confluence');
		field('Base URL', all.confluence.baseUrl);
		field('Email', all.confluence.email);
		field('Token', mask(all.confluence.token));
		field('Default space', all.confluence.defaultSpace);

		console.log('');
		divider();
		field('Config file', configPath());
		console.log('');
	});

config
	.command('set <key> <value>')
	.description('Set a config value (e.g. bitbucket.workspace my-ws)')
	.action((key, value) => {
		const validKeys = [
			'bitbucket.workspace', 'bitbucket.defaultRepo', 'bitbucket.email', 'bitbucket.token',
			'jira.baseUrl', 'jira.token', 'jira.defaultProject',
			'confluence.baseUrl', 'confluence.email', 'confluence.token', 'confluence.defaultSpace',
		];
		if (!validKeys.includes(key)) {
			error(`Invalid key: ${key}`);
			console.log(`Valid keys: ${validKeys.join(', ')}`);
			return;
		}
		set(key, value);
		success(`Set ${key}`);
	});

export default config;
