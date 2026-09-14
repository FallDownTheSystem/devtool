#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { isConfigured, runSetup } from './config/store.js';
import configCmd from './commands/config.js';
import prCmd from './commands/pr.js';
import jiraCmd from './commands/jira.js';
import confluenceCmd from './commands/confluence.js';
import sdCmd from './commands/sd.js';
import graphCmd from './commands/graph.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const program = new Command();

program
	.name('dev')
	.description('CLI for Bitbucket, Jira, Confluence, Service Desk, and Microsoft Graph')
	.version(version)
	.option('--json', 'Output raw JSON')
	.option('--plain', 'Output compact plain text (no tables, no colors)');

program.addCommand(configCmd);
program.addCommand(prCmd);
program.addCommand(jiraCmd);
program.addCommand(confluenceCmd);
program.addCommand(sdCmd);
program.addCommand(graphCmd);

program.hook('preAction', async (thisCommand, actionCommand) => {
	const cmdChain = [];
	let cmd = actionCommand;
	while (cmd) {
		cmdChain.unshift(cmd.name());
		cmd = cmd.parent;
	}
	if (cmdChain.includes('config') || cmdChain.includes('graph')) return;

	if (!isConfigured()) {
		console.log('First run detected. Let\'s set up your configuration.\n');
		await runSetup();
		console.log('');
	}
});

program.parse();
