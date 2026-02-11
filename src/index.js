#!/usr/bin/env node

import { Command } from 'commander';
import { isConfigured, runSetup } from './config/store.js';
import configCmd from './commands/config.js';
import prCmd from './commands/pr.js';
import jiraCmd from './commands/jira.js';

const program = new Command();

program
	.name('dev')
	.description('CLI for Bitbucket PRs and Jira tickets')
	.version('0.1.0');

program.addCommand(configCmd);
program.addCommand(prCmd);
program.addCommand(jiraCmd);

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
