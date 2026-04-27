#!/usr/bin/env node

import { Command } from 'commander';
import { isConfigured, runSetup } from './config/store.js';
import configCmd from './commands/config.js';
import prCmd from './commands/pr.js';
import jiraCmd from './commands/jira.js';
import confluenceCmd from './commands/confluence.js';
import sdCmd from './commands/sd.js';

const program = new Command();

program
	.name('dev')
	.description('CLI for Bitbucket PRs, Jira tickets, Confluence pages, and Service Desk tickets')
	.version('0.4.0')
	.option('--json', 'Output raw JSON')
	.option('--plain', 'Output compact plain text (no tables, no colors)');

program.addCommand(configCmd);
program.addCommand(prCmd);
program.addCommand(jiraCmd);
program.addCommand(confluenceCmd);
program.addCommand(sdCmd);

program.hook('preAction', async (thisCommand, actionCommand) => {
	const cmdChain = [];
	let cmd = actionCommand;
	while (cmd) {
		cmdChain.unshift(cmd.name());
		cmd = cmd.parent;
	}
	if (cmdChain.includes('config')) return;

	if (!isConfigured()) {
		console.log('First run detected. Let\'s set up your configuration.\n');
		await runSetup();
		console.log('');
	}
});

program.parse();
