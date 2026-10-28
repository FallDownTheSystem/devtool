// Building blocks of `dev api`: path validation, the --select projection, and pagination.

function basePath(base) {
	return base.pathname.replace(/\/+$/, '');
}

function invalidPath(path, reason) {
	return new Error(`Invalid path "${path}": ${reason}. Give a path relative to the connection's base URL, such as /rest/api/2/myself.`);
}

// Decodes percent-encoding until it is stable, so encoded tricks such as %2e%2e or %252e are seen as
// what a server may eventually read.
function fullyDecoded(path) {
	let current = path;
	for (let i = 0; i < 5; i++) {
		let next;
		try {
			next = decodeURIComponent(current);
		} catch {
			throw invalidPath(path, 'it has invalid percent-encoding');
		}
		if (next === current) return current;
		current = next;
	}
	throw invalidPath(path, 'it is percent-encoded too many times');
}

// The URL of `path` under the connection's base URL. Anything that could leave the base (an absolute or
// scheme-relative URL, a dot segment, a backslash, an encoded variant of these) is rejected, so the
// connection's credentials only go to its own site. A query in `path` is kept; `query` entries are added.
export function apiUrl(base, path, query = []) {
	if (typeof path !== 'string' || !path.startsWith('/')) throw invalidPath(path, 'it must start with "/" (absolute URLs are not accepted)');
	if (path.startsWith('//')) throw invalidPath(path, 'a scheme-relative URL could point to another host');
	if (/[\\\u0000-\u001f\u007f#]/.test(path)) throw invalidPath(path, 'it contains a backslash, a control character, or "#"');
	const q = path.indexOf('?');
	const pathPart = q === -1 ? path : path.slice(0, q);
	const decoded = fullyDecoded(pathPart);
	if (/[\\\u0000-\u001f\u007f]/.test(decoded)) throw invalidPath(path, 'it contains an encoded backslash or control character');
	if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) throw invalidPath(path, 'it contains a "." or ".." segment');
	if (decoded.includes('//')) throw invalidPath(path, 'it contains an empty segment');

	const prefix = basePath(base);
	const url = new URL(`${base.origin}${prefix}${pathPart}`);
	if (url.origin !== base.origin || !(url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
		throw invalidPath(path, 'it resolves outside the connection\'s site');
	}
	const params = new URLSearchParams(q === -1 ? '' : path.slice(q + 1));
	for (const [key, value] of query) params.append(key, value);
	url.search = params.toString();
	return url;
}

// The path of `url` relative to the base, as `dev api` takes it.
export function relativePath(base, url) {
	return `${url.pathname.slice(basePath(base).length)}${url.search}`;
}

export function parseQuery(entries = []) {
	return entries.map((entry) => {
		const eq = entry.indexOf('=');
		if (eq <= 0) throw new Error(`Invalid --query "${entry}". Use <key>=<value>, e.g. fields=summary,status.`);
		return [entry.slice(0, eq), entry.slice(eq + 1)];
	});
}

// --- --select ---
//
// A small projection syntax:
//   a.b.c          follow keys (an array index is a key too: issues.0.key)
//   []             each item of an array (or each value of an object): issues[].key
//   {a,b.c}        an object with the given paths, keyed by the path as written: [].{id,name,schema.type}

function selectError(expr, reason) {
	return new Error(`Invalid --select "${expr}": ${reason}. Use dot paths, [] for each item, and {a,b} to pick keys, e.g. issues[].{key,fields.summary}.`);
}

// Splits `text` at commas outside braces.
function splitTop(text) {
	const parts = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '{') depth++;
		else if (text[i] === '}') depth--;
		else if (text[i] === ',' && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts.map((p) => p.trim());
}

export function parseSelect(expr) {
	const steps = [];
	let i = 0;
	while (i < expr.length) {
		const c = expr[i];
		if (c === '.') {
			if (i === 0 || i === expr.length - 1 || expr[i + 1] === '.') throw selectError(expr, 'misplaced "."');
			i++;
		} else if (c === '[') {
			if (expr[i + 1] !== ']') throw selectError(expr, '"[" must be followed by "]"');
			steps.push({ each: true });
			i += 2;
		} else if (c === '{') {
			let depth = 0;
			let j = i;
			for (; j < expr.length; j++) {
				if (expr[j] === '{') depth++;
				else if (expr[j] === '}' && --depth === 0) break;
			}
			if (j === expr.length) throw selectError(expr, 'unclosed "{"');
			const parts = splitTop(expr.slice(i + 1, j));
			if (parts.some((p) => !p)) throw selectError(expr, 'empty key in "{}"');
			steps.push({ pick: parts.map((p) => [p, parseSelect(p)]) });
			i = j + 1;
		} else if (']},'.includes(c)) {
			throw selectError(expr, `unexpected "${c}"`);
		} else {
			let j = i;
			while (j < expr.length && !'.[]{},'.includes(expr[j])) j++;
			steps.push({ key: expr.slice(i, j).trim() });
			i = j;
		}
	}
	if (!steps.length) throw selectError(expr, 'it is empty');
	return steps;
}

function apply(value, steps, from) {
	let current = value;
	for (let k = from; k < steps.length; k++) {
		const step = steps[k];
		if (current === null || current === undefined) return null;
		if (step.each) {
			if (typeof current !== 'object') return null;
			return (Array.isArray(current) ? current : Object.values(current)).map((item) => apply(item, steps, k + 1));
		}
		if (step.pick) current = Object.fromEntries(step.pick.map(([name, sub]) => [name, apply(current, sub, 0)]));
		else current = typeof current === 'object' ? current[step.key] : undefined;
	}
	return current === undefined ? null : current;
}

export function select(value, expr) {
	return apply(value, parseSelect(expr), 0);
}

// --- Pagination ---
//
// Detected from the response shape, which covers every style these APIs use:
//   nextPageToken + isLast      Jira Cloud (/rest/api/3/search/jql and others)
//   next (absolute URL)         Bitbucket
//   _links.next                 Confluence (v2 cursor links, v1 links), Service Desk API
//   startAt + maxResults/total  Jira Server and other Jira Cloud endpoints

const ITEM_KEYS = ['values', 'issues', 'results', 'comments', 'worklogs', 'fields', 'issueTypes'];

export function itemsKey(data) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
	return ITEM_KEYS.find((key) => Array.isArray(data[key])) || Object.keys(data).find((key) => Array.isArray(data[key]));
}

// A pagination link must stay under the base like any requested path. Server/Data Center links can be
// relative to the context path instead of the origin.
function linkUrl(base, link, current) {
	const prefix = basePath(base);
	const contextRelative = link.startsWith('/') && !link.startsWith('//') && prefix && !link.startsWith(`${prefix}/`);
	const url = contextRelative ? new URL(`${base.origin}${prefix}${link}`) : new URL(link, current);
	if (url.origin !== base.origin || !(url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
		throw new Error('The pagination link points outside the connection\'s site; it was not followed.');
	}
	return url;
}

export function nextPageUrl(data, current, base) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
	if (typeof data.nextPageToken === 'string' && data.nextPageToken && data.isLast !== true) {
		const url = new URL(current);
		url.searchParams.set('nextPageToken', data.nextPageToken);
		return url;
	}
	if (typeof data.next === 'string' && data.next) return linkUrl(base, data.next, current);
	if (typeof data._links?.next === 'string' && data._links.next) return linkUrl(base, data._links.next, current);
	const key = itemsKey(data);
	if (typeof data.startAt === 'number' && key && data.isLast !== true) {
		const next = data.startAt + data[key].length;
		const more = typeof data.total === 'number' ? next < data.total : data.isLast === false;
		if (!more || !data[key].length) return null;
		const url = new URL(current);
		url.searchParams.set('startAt', String(next));
		return url;
	}
	return null;
}

// Follows pagination from `first` up to `limit` items. The result has the shape of the first page with
// all items in its item array and the cursors removed.
export async function collectAllPages(fetchPage, first, base, limit) {
	let url = first;
	let data = await fetchPage(url);
	const key = itemsKey(data);
	if (!key) return { data, truncated: false, pages: 1 };
	const firstPage = data;
	const items = [...data[key]];
	const seen = new Set([url.toString()]);
	let pages = 1;
	let truncated = false;
	for (let next = nextPageUrl(data, url, base); next; next = nextPageUrl(data, url, base)) {
		if (items.length >= limit) {
			truncated = true;
			break;
		}
		if (seen.has(next.toString())) break;
		seen.add(next.toString());
		url = next;
		data = await fetchPage(url);
		items.push(...(Array.isArray(data?.[key]) ? data[key] : []));
		pages++;
	}
	if (items.length > limit) truncated = true;
	const result = { ...firstPage, [key]: items.slice(0, limit) };
	delete result.next;
	delete result.nextPageToken;
	if (result._links) {
		result._links = { ...result._links };
		delete result._links.next;
	}
	if ('isLast' in result) result.isLast = !truncated;
	return { data: result, truncated, pages };
}
