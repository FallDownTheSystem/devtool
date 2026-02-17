import { table, heading, field, divider, pc } from '../utils/output.js';

function stripHtml(html) {
	if (!html) return '';
	return html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n')
		.replace(/<\/li>/gi, '\n')
		.replace(/<\/h[1-6]>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

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
		status: page.status || null,
		createdAt: page.createdAt || null,
		version: page.version?.number || null,
		body: stripHtml(page.body?.storage?.value),
	};
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
			excerpt: stripHtml(r.excerpt),
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
	if (page.spaceId) console.log(`Space ID: ${page.spaceId}`);
	console.log(`Status: ${page.status || 'current'}`);
	if (page.version?.number) console.log(`Version: ${page.version.number}`);
	if (page.createdAt) console.log(`Created: ${page.createdAt}`);
	const body = stripHtml(page.body?.storage?.value);
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
		const excerpt = stripHtml(r.excerpt).split('\n')[0].slice(0, 100);
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
	if (page.spaceId) field('Space ID', page.spaceId);
	field('Status', page.status || 'current');
	if (page.version?.number) field('Version', page.version.number);
	if (page.createdAt) field('Created', new Date(page.createdAt).toLocaleString());

	const body = stripHtml(page.body?.storage?.value);
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
		stripHtml(r.excerpt).split('\n')[0].slice(0, 60),
	]);

	console.log(table(['ID', 'Title', 'Space', 'Excerpt'], rows));

	if (result.totalSize > results.length) {
		console.log(pc.dim(`  Showing ${results.length} of ${result.totalSize} results`));
	}
	console.log('');
}
