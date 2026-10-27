import { Command } from 'commander';
import {
	listSpaces,
	getPage,
	listSpacePages,
	searchPages,
	listPageComments,
} from '../clients/confluence.js';
import {
	formatSpaces, formatPageView, formatPages, formatSearch, formatComments,
	plainSpaces, plainPageView, plainPages, plainSearch, plainComments,
	curateSpacesJson, curatePageJson, curatePagesJson, curateSearchJson, curateCommentsJson,
} from '../formatters/confluence.js';
import * as actions from '../actions/confluence.js';
import { runWrite, readText, FILE_HELP } from '../utils/write.js';
import { textToStorage } from '../utils/markup.js';
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
	.option('--storage', 'Show the body in storage format (XHTML), the format that edit takes')
	.action(async function (id, opts) {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner(`Fetching page ${id}...`).start() : null;
		try {
			const page = await getPage(connectionFor(this, 'confluence'), id);
			if (s) s.success({ text: page.title || `Page ${id}` });
			const storage = page.body?.storage?.value || '';
			if (mode === 'json') outputJson(opts.storage ? { ...curatePageJson(page), body: storage } : curatePageJson(page));
			else if (opts.storage) console.log(storage);
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

confluence.command('comments <pageId>')
	.description('List the footer comments of a page')
	.action(async function (pageId) {
		const mode = getOutputMode(this);
		const s = mode === 'rich' ? spinner(`Fetching comments for page ${pageId}...`).start() : null;
		try {
			const comments = await listPageComments(connectionFor(this, 'confluence'), pageId);
			if (s) s.success({ text: `${comments.length} comment(s)` });
			if (mode === 'json') outputJson(curateCommentsJson(comments));
			else if (mode === 'plain') plainComments(comments);
			else formatComments(comments);
		} catch (err) {
			if (s) s.error({ text: `Failed to fetch comments for page ${pageId}` });
			handleError(err, err.url || 'confluence');
		}
	});

const TEXT_HELP = 'Treat the body as plain text instead of storage format (XHTML)';

function body(text, opts) {
	const value = readText(text, opts.file);
	return value !== undefined && opts.text ? textToStorage(value) : value;
}

confluence.command('create')
	.description('Create a page; the body is in storage format (XHTML) unless --text is given')
	.requiredOption('-t, --title <text>', 'Title')
	.option('-b, --body <xhtml>', 'Body')
	.option('-F, --file <path>', FILE_HELP)
	.option('--text', TEXT_HELP)
	.option('-s, --space <key>', 'Space key (overrides default)')
	.option('--space-id <id>', 'Space ID (instead of a key)')
	.option('--parent <id>', 'Parent page ID')
	.action(async function (opts) {
		await runWrite(this, actions.pageCreate, () => ({
			title: opts.title,
			body: body(opts.body, opts),
			spaceKey: opts.space,
			spaceId: opts.spaceId,
			parentId: opts.parent,
		}));
	});

confluence.command('edit <id>')
	.description('Replace the title or body of a page; get the current body with `view <id> --storage`')
	.option('-t, --title <text>', 'New title')
	.option('-b, --body <xhtml>', 'New body')
	.option('-F, --file <path>', FILE_HELP)
	.option('--text', TEXT_HELP)
	.option('-m, --message <text>', 'Version comment')
	.action(async function (id, opts) {
		await runWrite(this, actions.pageEdit, () => ({
			id, title: opts.title, body: body(opts.body, opts), message: opts.message,
		}));
	});

confluence.command('delete <id>')
	.alias('rm')
	.description('Delete a page (Cloud moves it to the trash)')
	.action(async function (id) {
		await runWrite(this, actions.pageDelete, () => ({ id }));
	});

const comment = confluence.command('comment')
	.description('Add or delete page comments');

comment.command('add <pageId> [body]')
	.description('Add a footer comment; the body is in storage format (XHTML) unless --text is given')
	.option('-F, --file <path>', FILE_HELP)
	.option('--text', TEXT_HELP)
	.action(async function (pageId, text, opts) {
		await runWrite(this, actions.commentAdd, () => ({ pageId, body: body(text, opts) }));
	});

comment.command('delete <commentId>')
	.alias('rm')
	.description('Delete a footer comment')
	.action(async function (id) {
		await runWrite(this, actions.commentDelete, () => ({ id }));
	});

export default confluence;
