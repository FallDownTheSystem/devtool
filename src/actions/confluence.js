import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
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

function requireChange(input) {
	if (input.title === undefined && input.body === undefined) throw new Error('Nothing to change. Pass --title, --body, or --file.');
	if (input.body !== undefined) requireText(input.body, 'page body');
}

function editParams(input, page) {
	return {
		id: input.id,
		currentTitle: page.title,
		version: page.version?.number,
		title: input.title ?? page.title,
		body: input.body ?? page.body?.storage?.value ?? '',
		bodyChanged: input.body !== undefined,
		message: input.message,
	};
}

// The version read here is sent back as the base of the update, so a page edited by someone else
// after this preview is rejected with a conflict instead of being overwritten.
export const pageEdit = {
	name: 'confluence.page.edit',
	type: 'confluence',
	async prepare(connection, input) {
		requireChange(input);
		return editParams(input, await client.getPage(connection, input.id));
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

// Prepared like an edit, but sent as the page's draft: the published version stays as readers see it.
export const pageDraft = {
	name: 'confluence.page.draft',
	type: 'confluence',
	async prepare(connection, input) {
		if (await client.deploymentOfConnection(connection) !== 'cloud') {
			throw new Error('Drafts of published pages can be saved only on Confluence Cloud; Server/Data Center has no REST API for them.');
		}
		requireChange(input);
		const page = await client.getPage(connection, input.id);
		if (page.status !== 'current') throw new Error(`Page ${input.id} is not published (status ${page.status}). --draft saves a draft of a published page.`);
		return editParams(input, page);
	},
	// A draft is always version 1, so no conflict catches a page published again after the preview; a draft
	// prepared from an older published version would undo those changes when it is published.
	async verify(connection, p) {
		const now = (await client.getPage(connection, p.id)).version?.number;
		if (now !== p.version) {
			const err = new Error(`Page ${p.id} was published again after the preview (version ${p.version} → ${now}). Reject this action and request it again.`);
			err.stale = true;
			throw err;
		}
	},
	summary: (p) => `Save a draft of page ${pageLine({ id: p.id, title: p.currentTitle })}`,
	details: (p) => [
		['Published version', `${p.version} (not changed)`],
		['Existing draft', 'replaced by this one'],
		...(p.title !== p.currentTitle ? [['Draft title', p.title]] : []),
		...(p.message ? [['Version message', p.message]] : []),
		['Draft body', p.bodyChanged ? p.body : '(the published body)'],
	],
	run: (connection, p) => client.saveDraft(connection, p.id, p),
	report: (_, p) => ({
		message: `Saved a draft of page ${p.id}; published version ${p.version} is not changed`,
		json: { id: p.id, title: p.title, status: 'draft', publishedVersion: p.version },
	}),
};

function sha256(data) {
	return createHash('sha256').update(data).digest('hex');
}

function readUpload(p) {
	const data = readFileSync(p.path);
	if (sha256(data) !== p.sha256) {
		const err = new Error(`${p.path} changed after the preview. Reject this action and request it again.`);
		err.stale = true;
		throw err;
	}
	return data;
}

async function assertNewName(connection, pageId, name) {
	const taken = (await client.listAttachments(connection, pageId)).find((a) => a.title === name);
	if (taken) {
		const err = new Error(`Page ${pageId} already has an attachment named "${name}" (${taken.id}). An upload never replaces one; give a new name with --name.`);
		err.stale = true;
		throw err;
	}
}

// Only the path and a SHA-256 of the file are stored; the bytes are read again when the action runs and
// must still match, so what is uploaded is the file that was previewed.
export const attachmentUpload = {
	name: 'confluence.attachment.upload',
	type: 'confluence',
	async prepare(connection, input) {
		const path = resolve(input.file);
		const data = readFileSync(path);
		const name = input.name ?? basename(path);
		if (!name.trim() || /[\\/]/.test(name)) throw new Error(`Invalid attachment name "${name}". Give a file name without a folder.`);
		await assertNewName(connection, input.pageId, name);
		return { pageId: input.pageId, path, name, size: data.length, sha256: sha256(data) };
	},
	preview: async (connection, p) => ({ title: (await client.getPage(connection, p.pageId)).title }),
	async verify(connection, p) {
		readUpload(p);
		await assertNewName(connection, p.pageId, p.name);
	},
	summary: (p) => `Attach "${p.name}" to page ${pageLine({ id: p.pageId, title: p.title ?? '' }).trimEnd()}`,
	details: (p) => [
		['File', p.path],
		['Attachment name', p.name],
		['Size', `${p.size} bytes`],
		['SHA-256', p.sha256],
	],
	run: async (connection, p) => client.uploadAttachment(connection, p.pageId, { name: p.name, data: readUpload(p) }),
	// The name is checked before the upload, but another upload can take it in between; a version above 1
	// means Confluence added the file to an existing attachment instead of refusing it.
	report: (attachment, p) => {
		const replaced = attachment.version > 1;
		return {
			message: replaced
				? `Confluence stored "${p.name}" as version ${attachment.version} of the existing attachment ${attachment.id} on page ${p.pageId} instead of refusing the name. Check the page's attachment history.`
				: `Attached "${attachment.title ?? p.name}" (${attachment.id}) to page ${p.pageId}`,
			json: { pageId: p.pageId, id: attachment.id, title: attachment.title ?? p.name, size: p.size, version: attachment.version },
			failed: replaced,
		};
	},
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
