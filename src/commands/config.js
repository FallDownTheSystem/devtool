import { Command } from 'commander';
import { getAll, set, runSetup, runGraphSetup, configPath, validateGraphId, validateGraphSite } from '../config/store.js';
import { heading, field, mask, success, error, divider } from '../utils/output.js';
import { getOutputMode } from '../utils/mode.js';

const config = new Command('config')
	.description('Manage configuration');

config
	.command('setup [service]')
	.description('Run interactive setup (use graph for Microsoft Graph only)')
	.action(async function (service) {
		try {
			if (service === 'graph' && getOutputMode(this) !== 'rich') throw new Error('Graph setup requires a terminal without --json or --plain.');
			if (service === 'graph') await runGraphSetup();
			else if (!service) await runSetup();
			else throw new Error('Unknown setup service. Use: dev config setup graph');
		} catch (err) {
			error(err.message);
			process.exitCode = 1;
		}
	});

config
	.command('show')
	.alias('get')
	.description('Show current configuration')
	.action(() => {
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

		heading('Microsoft Graph (Teams, email, calendars, SharePoint)');
		field('Tenant ID', all.graph.tenantId);
		field('Client ID', all.graph.clientId);
		field('Default site', all.graph.defaultSite);
		field('Authentication', 'Delegated sign-in; OS-protected token cache');

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
			'graph.tenantId', 'graph.clientId', 'graph.defaultSite',
		];
		if (!validKeys.includes(key)) {
			error(`Invalid key: ${key}`);
			console.log(`Valid keys: ${validKeys.join(', ')}`);
			return;
		}
		const validation = ['graph.tenantId', 'graph.clientId'].includes(key)
			? validateGraphId(value)
			: key === 'graph.defaultSite' ? validateGraphSite(value) : undefined;
		if (validation) {
			error(validation);
			process.exitCode = 1;
			return;
		}
		if (key.startsWith('graph.')) value = value.trim();
		set(key, value);
		success(`Set ${key}`);
	});

export default config;
