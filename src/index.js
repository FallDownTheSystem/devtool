#!/usr/bin/env node

import { createRequire } from 'node:module';
import { Command } from 'commander';
import configCmd from './commands/config.js';
import prCmd from './commands/pr.js';
import jiraCmd, { sd as sdCmd } from './commands/jira.js';
import confluenceCmd from './commands/confluence.js';
import graphCmd from './commands/graph.js';
import pendingCmd from './commands/pending.js';
import apiCmd from './commands/api.js';

const { version } = createRequire(import.meta.url)('../package.json');

const program = new Command();

program
	.name('dev')
	.description('CLI for Bitbucket, Jira, Confluence, Service Desk, and Microsoft Graph')
	.version(version)
	.option('--json', 'Output raw JSON')
	.option('--plain', 'Output compact plain text (no tables, no colors)')
	.option('-c, --connection <name>', 'Connection to use (defaults to the default connection of the command\'s type)')
	.option('--approve', 'Run a write at once instead of holding it for approval. Use only when the user approved this exact change')
	.option('--replaces <id>', 'Discard this pending action in favor of the write being requested, e.g. after the user asked for changes');

program.addCommand(configCmd);
program.addCommand(prCmd);
program.addCommand(jiraCmd);
program.addCommand(confluenceCmd);
program.addCommand(sdCmd);
program.addCommand(graphCmd);
program.addCommand(pendingCmd);
program.addCommand(apiCmd);

program.parse();
