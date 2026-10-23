import { Command } from 'commander';
import {
	listSpaces,
	getPage,
	listSpacePages,
	searchPages,
} from '../clients/confluence.js';
import {
	formatSpaces, formatPageView, formatPages, formatSearch,
	plainSpaces, plainPageView, plainPages, plainSearch,
	curateSpacesJson, curatePageJson, curatePagesJson, curateSearchJson,
} from '../formatters/confluence.js';
import { spinner } from '../utils/output.js';
import { handleError } from '../utils/errors.js';
import { getOutputMode, outputJson } from '../utils/mode.js';
import { connectionFor } from '../utils/connection.js';

const confluence = new Command('confluence')
	.description('Confluence pages');

confluence.command('spaces')
	.description('List all spaces')
	.action(async function () {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner('Fetching spaces...').start() : null;
		try {
			const spaces = await listSpaces(connectionFor(this, 'confluence'));
			if (s) s.success({ text: `${spaces.length} space(s) found` });
			if (mode === 'json') outputJson(curateSpacesJson(spaces));
			else if (mode === 'plain') plainSpaces(spaces);
			else formatSpaces(spaces);
		} catch (err) {
			if (s) s.error({ text: 'Failed to fetch spaces' });
			handleError(err, err.url || 'confluence');
		}
	});

confluence.command('view <id>')
	.alias('read')
	.description('View a page')
	.action(async function (id) {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner(`Fetching page ${id}...`).start() : null;
		try {
			const page = await getPage(connectionFor(this, 'confluence'), id);
			if (s) s.success({ text: page.title || `Page ${id}` });
			if (mode === 'json') outputJson(curatePageJson(page));
			else if (mode === 'plain') plainPageView(page);
			else formatPageView(page);
		} catch (err) {
			if (s) s.error({ text: `Failed to fetch page ${id}` });
			handleError(err, err.url || 'confluence');
		}
	});

confluence.command('pages')
	.alias('ls')
	.description('List pages in a space')
	.option('-s, --space <key>', 'Space key (overrides default)')
	.option('--space-id <id>', 'Space ID (instead of a key)')
	.action(async function (opts) {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner('Fetching pages...').start() : null;
		try {
			const connection = connectionFor(this, 'confluence');
			const spaceId = opts.spaceId;
			const spaceKey = spaceId ? undefined : opts.space || connection.defaultSpace;
			if (!spaceId && !spaceKey) {
				if (s) s.error({ text: 'No space specified' });
				console.error('Specify --space <key>, --space-id <id>, or set defaultSpace on the Confluence connection');
				process.exitCode = 1;
				return;
			}
			const pages = await listSpacePages(connection, { spaceId, spaceKey });
			if (!pages) {
				if (s) s.error({ text: `Space "${spaceId || spaceKey}" not found` });
				process.exitCode = 1;
				return;
			}
			if (s) s.success({ text: `${pages.length} page(s) found` });
			if (mode === 'json') outputJson(curatePagesJson(pages));
			else if (mode === 'plain') plainPages(pages);
			else formatPages(pages);
		} catch (err) {
			if (s) s.error({ text: 'Failed to fetch pages' });
			handleError(err, err.url || 'confluence');
		}
	});

confluence.command('search <cql>')
	.alias('find')
	.description('Search pages with CQL')
	.action(async function (cql) {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner('Searching...').start() : null;
		try {
			const result = await searchPages(connectionFor(this, 'confluence'), cql);
			const count = result.totalSize || (result.results || []).length;
			if (s) s.success({ text: `${count} result(s)` });
			if (mode === 'json') outputJson(curateSearchJson(result));
			else if (mode === 'plain') plainSearch(result);
			else formatSearch(result);
		} catch (err) {
			if (s) s.error({ text: 'Search failed' });
			handleError(err, err.url || 'confluence');
		}
	});

export default confluence;
