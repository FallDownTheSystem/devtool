import * as client from '../clients/confluence.js';
import { storageToText } from '../utils/markup.js';
import { requireText } from './require.js';

function pageLine(page) {
	return `${page.id} ${page.title}`;
}

export const pageCreate = {
	name: 'confluence.page.create',
	type: 'confluence',
	async prepare(connection, input) {
		if (!input.title) throw new Error('A title is required. Pass --title <text>.');
		requireText(input.body, 'page body');
		const spaceKey = input.spaceId ? undefined : input.spaceKey || connection.defaultSpace;
		if (!input.spaceId && !spaceKey) throw new Error('No space specified. Pass --space <key>, --space-id <id>, or set defaultSpace on the Confluence connection.');
		return { ...input, spaceKey };
	},
	summary: (p) => `Create page "${p.title}" in space ${p.spaceId || p.spaceKey}`,
	details: (p) => [
		...(p.parentId ? [['Parent page', p.parentId]] : []),
		['Title', p.title],
		['Body (storage format)', p.body],
	],
	run: (connection, p) => client.createPage(connection, p),
	report: (page) => ({ message: `Created page ${page.id}: ${page.title}`, json: { id: page.id, title: page.title } }),
};

// The version read here is sent back as the base of the update, so a page edited by someone else
// after this preview is rejected with a conflict instead of being overwritten.
export const pageEdit = {
	name: 'confluence.page.edit',
	type: 'confluence',
	async prepare(connection, input) {
		if (input.title === undefined && input.body === undefined) throw new Error('Nothing to change. Pass --title, --body, or --file.');
		if (input.body !== undefined) requireText(input.body, 'page body');
		const page = await client.getPage(connection, input.id);
		return {
			id: input.id,
			currentTitle: page.title,
			version: page.version?.number,
			title: input.title ?? page.title,
			body: input.body ?? page.body?.storage?.value ?? '',
			bodyChanged: input.body !== undefined,
			message: input.message,
		};
	},
	summary: (p) => `Edit page ${pageLine({ id: p.id, title: p.currentTitle })}`,
	details: (p) => [
		['Version', `${p.version} → ${p.version + 1}`],
		...(p.title !== p.currentTitle ? [['New title', p.title]] : []),
		...(p.message ? [['Version message', p.message]] : []),
		['Body', p.bodyChanged ? p.body : '(unchanged)'],
	],
	run: (connection, p) => client.updatePage(connection, p.id, p),
	report: (_, p) => ({ message: `Updated page ${p.id} to version ${p.version + 1}`, json: { id: p.id, title: p.title, version: p.version + 1 } }),
};

export const pageDelete = {
	name: 'confluence.page.delete',
	type: 'confluence',
	preview: async (connection, p) => ({ title: (await client.getPage(connection, p.id)).title }),
	summary: (p) => `Delete page ${pageLine(p)}`,
	details: (p) => [['Page', pageLine(p)]],
	run: (connection, p) => client.deletePage(connection, p.id),
	report: (_, p) => ({ message: `Deleted page ${p.id}`, json: { id: p.id } }),
};

export const commentAdd = {
	name: 'confluence.comment.add',
	type: 'confluence',
	async prepare(connection, input) {
		requireText(input.body, 'comment');
		return input;
	},
	preview: async (connection, p) => ({ title: (await client.getPage(connection, p.pageId)).title }),
	summary: (p) => `Comment on page ${pageLine({ id: p.pageId, title: p.title })}`,
	details: (p) => [['Comment (storage format)', p.body]],
	run: (connection, p) => client.addPageComment(connection, p.pageId, p.body),
	report: (comment, p) => ({ message: `Added comment ${comment.id} to page ${p.pageId}`, json: { pageId: p.pageId, id: comment.id } }),
};

export const commentDelete = {
	name: 'confluence.comment.delete',
	type: 'confluence',
	async preview(connection, p) {
		const comment = await client.getPageComment(connection, p.id);
		return { author: comment.author, current: storageToText(comment.body) };
	},
	summary: (p) => `Delete comment ${p.id}`,
	details: (p) => [['Author', p.author || 'Unknown'], ['Comment', p.current]],
	run: (connection, p) => client.deletePageComment(connection, p.id),
	report: (_, p) => ({ message: `Deleted comment ${p.id}`, json: { id: p.id } }),
};
