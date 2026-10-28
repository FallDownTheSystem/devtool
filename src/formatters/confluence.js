import { table, heading, field, divider, pc } from '../utils/output.js';
import { storageToText } from '../utils/markup.js';

function relativeTime(dateStr) {
	if (!dateStr) return '';
	const diff = Date.now() - new Date(dateStr).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(dateStr).toLocaleDateString();
}

function spaceType(type) {
	if (!type) return '';
	if (type === 'global') return pc.blue('global');
	if (type === 'personal') return pc.dim('personal');
	return type;
}

// --- JSON curators ---

export function curateSpacesJson(spaces) {
	return spaces.map((s) => ({
		id: s.id,
		key: s.key,
		name: s.name,
		type: s.type || null,
		status: s.status || null,
	}));
}

export function curatePageJson(page) {
	return {
		id: page.id,
		title: page.title,
		spaceId: page.spaceId || null,
		spaceKey: page.space?.key || null,
		spaceName: page.space?.name || null,
		status: page.status || null,
		createdAt: page.createdAt || null,
		version: page.version?.number || null,
		versionAuthor: page.version?.author || null,
		versionDate: page.version?.createdAt || null,
		labels: page.labels || [],
		ancestors: page.ancestors || [],
		body: storageToText(page.body?.storage?.value),
	};
}

export function curateAttachmentsJson(attachments) {
	return attachments.map((a) => ({ id: a.id, title: a.title, fileSize: a.fileSize, mediaType: a.mediaType }));
}

function sizeText(bytes) {
	if (bytes == null) return '';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function plainAttachments(attachments) {
	if (attachments.length === 0) { console.log('No attachments.'); return; }
	for (const a of attachments) console.log(`${a.id} "${a.title}" ${sizeText(a.fileSize)} ${a.mediaType || ''}`.trimEnd());
}

export function formatAttachments(attachments) {
	if (attachments.length === 0) { console.log(pc.dim('  No attachments.')); return; }
	console.log(table(['ID', 'Name', 'Size', 'Media type'], attachments.map((a) => [a.id, a.title, sizeText(a.fileSize), a.mediaType || ''])));
}

function spaceText(page) {
	return page.space.name ? `${page.space.key} (${page.space.name})` : page.space.key;
}

function breadcrumb(page) {
	return (page.ancestors || []).map((a) => a.title || a.id).join(' › ');
}

function versionText(page) {
	const v = page.version;
	if (!v?.number) return '';
	return [String(v.number), v.author && `by ${v.author}`, v.createdAt && `on ${v.createdAt}`].filter(Boolean).join(' ');
}

export function curatePagesJson(pages) {
	return pages.map((p) => ({
		id: p.id,
		title: p.title,
		status: p.status || null,
		createdAt: p.createdAt || null,
		version: p.version?.number || null,
	}));
}

export function curateSearchJson(result) {
	return {
		totalSize: result.totalSize || 0,
		results: (result.results || []).map((r) => ({
			title: r.content?.title || r.title || '',
			id: r.content?.id || r.id || null,
			type: r.content?.type || r.type || null,
			space: r.resultGlobalContainer?.title || null,
			excerpt: storageToText(r.excerpt),
			url: r.url || null,
			lastModified: r.lastModified || r.content?.version?.when || null,
		})),
	};
}

// --- Plain formatters ---

export function plainSpaces(spaces) {
	if (spaces.length === 0) { console.log('No spaces found.'); return; }
	for (const s of spaces) {
		console.log(`${s.key} "${s.name}" (${s.type || 'unknown'}, ${s.status || 'current'})`);
	}
}

export function plainPageView(page) {
	console.log(`${page.id} ${page.title}`);
	if (page.space) console.log(`Space: ${spaceText(page)}`);
	else if (page.spaceId) console.log(`Space ID: ${page.spaceId}`);
	console.log(`Status: ${page.status || 'current'}`);
	if (page.version?.number) console.log(`Version: ${versionText(page)}`);
	if (page.createdAt) console.log(`Created: ${page.createdAt}`);
	if (page.ancestors?.length) console.log(`Ancestors: ${breadcrumb(page)}`);
	if (page.labels?.length) console.log(`Labels: ${page.labels.join(', ')}`);
	if (page.children) {
		console.log(`Children: ${page.children.length}`);
		for (const c of page.children) console.log(`  ${c.id} "${c.title}"`);
	}
	const body = storageToText(page.body?.storage?.value);
	if (body) console.log(`Content:\n${body}`);
}

export function plainPages(pages) {
	if (pages.length === 0) { console.log('No pages found.'); return; }
	for (const p of pages) {
		console.log(`${p.id} "${p.title}" (${p.status || 'current'})`);
	}
}

export function plainSearch(result) {
	const results = result.results || [];
	if (results.length === 0) { console.log('No results found.'); return; }
	for (const r of results) {
		const title = r.content?.title || r.title || 'Untitled';
		const id = r.content?.id || '';
		const space = r.resultGlobalContainer?.title || '';
		const excerpt = storageToText(r.excerpt).split('\n')[0].slice(0, 100);
		console.log(`${id} [${space}] "${title}" - ${excerpt}`);
	}
	if (result.totalSize > results.length) {
		console.log(`Showing ${results.length} of ${result.totalSize} results`);
	}
}

// --- Rich formatters ---

export function formatSpaces(spaces) {
	if (spaces.length === 0) {
		console.log(pc.dim('  No spaces found.'));
		return;
	}

	const rows = spaces.map((s) => [
		pc.bold(s.key),
		s.name || '',
		spaceType(s.type),
		s.status || 'current',
	]);

	console.log(table(['Key', 'Name', 'Type', 'Status'], rows));
}

export function formatPageView(page) {
	heading(`${page.title}`);
	divider();
	field('Page ID', page.id);
	if (page.space) field('Space', spaceText(page));
	else if (page.spaceId) field('Space ID', page.spaceId);
	field('Status', page.status || 'current');
	if (page.version?.number) field('Version', versionText(page));
	if (page.createdAt) field('Created', new Date(page.createdAt).toLocaleString());
	if (page.ancestors?.length) field('Ancestors', breadcrumb(page));
	if (page.labels?.length) field('Labels', page.labels.join(', '));
	if (page.children) {
		heading(`Child pages (${page.children.length})`);
		for (const c of page.children) console.log(`  ${pc.dim(c.id)} ${c.title}`);
	}

	const body = storageToText(page.body?.storage?.value);
	if (body) {
		heading('Content');
		const lines = body.split('\n');
		const truncated = lines.slice(0, 50);
		for (const line of truncated) {
			console.log(`  ${line}`);
		}
		if (lines.length > 50) {
			console.log(pc.dim(`  ... (${lines.length - 50} more lines)`));
		}
	}

	console.log('');
}

export function formatPages(pages) {
	if (pages.length === 0) {
		console.log(pc.dim('  No pages found.'));
		return;
	}

	const rows = pages.map((p) => [
		p.id,
		(p.title || '').length > 60 ? p.title.slice(0, 57) + '...' : (p.title || ''),
		p.status || 'current',
		p.version?.number || '',
		relativeTime(p.createdAt),
	]);

	console.log(table(['ID', 'Title', 'Status', 'Version', 'Created'], rows));
}

export function formatSearch(result) {
	const results = result.results || [];
	if (results.length === 0) {
		console.log(pc.dim('  No results found.'));
		return;
	}

	const rows = results.map((r) => [
		r.content?.id || '',
		(r.content?.title || r.title || '').length > 50
			? (r.content?.title || r.title || '').slice(0, 47) + '...'
			: (r.content?.title || r.title || ''),
		r.resultGlobalContainer?.title || '',
		storageToText(r.excerpt).split('\n')[0].slice(0, 60),
	]);

	console.log(table(['ID', 'Title', 'Space', 'Excerpt'], rows));

	if (result.totalSize > results.length) {
		console.log(pc.dim(`  Showing ${results.length} of ${result.totalSize} results`));
	}
	console.log('');
}

export function curateCommentsJson(comments) {
	return comments.map((c) => ({
		id: c.id,
		author: c.author,
		date: c.createdAt,
		body: storageToText(c.body),
	}));
}

export function plainComments(comments) {
	if (comments.length === 0) { console.log('No comments.'); return; }
	for (const c of comments) {
		console.log(`#${c.id} ${c.author || 'Unknown'} (${relativeTime(c.createdAt)}): ${storageToText(c.body)}`);
	}
}

export function formatComments(comments) {
	if (comments.length === 0) {
		console.log(pc.dim('  No comments.'));
		return;
	}
	for (const c of comments) {
		console.log(`\n  ${pc.bold(c.author || 'Unknown')} ${pc.dim(`${relativeTime(c.createdAt)} #${c.id}`)}`);
		for (const line of storageToText(c.body).split('\n')) {
			console.log(`  ${line}`);
		}
	}
	console.log('');
}
