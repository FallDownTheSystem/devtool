import { open, rm, lstat, mkdtemp, link } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { graphAuth } from './graph-auth.js';
import { get, validateGraphSite } from '../config/store.js';

const BASE = 'https://graph.microsoft.com/v1.0';
const MAIL_FIELDS = 'id,subject,from,toRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,bodyPreview,webLink,parentFolderId';

export function graphUrl(path, params = {}) {
	const url = new URL(path.startsWith('/') ? `${BASE}${path}` : path);
	if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/') || url.username || url.password || url.hash) {
		throw new Error('Refused an invalid Microsoft Graph URL.');
	}
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
	}
	return url;
}

export function graphId(value) {
	if (typeof value !== 'string' || !value.trim() || value === '.' || value === '..') throw new Error('A resource ID is required.');
	return encodeURIComponent(value);
}

export function graphLimit(value = 25) {
	if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 1000) {
		throw new Error('Limit must be an integer from 1 to 1000.');
	}
	return Number(value);
}

export function siteAddress(site) {
	if (!site) throw new Error('Set graph.defaultSite or pass --site <site-url-or-id>.');
	if (!/^https?:/i.test(site)) return `/sites/${graphId(site)}`;
	const invalid = validateGraphSite(site);
	if (invalid) throw new Error(invalid);
	const url = new URL(site);
	const path = url.pathname.split('/').filter(Boolean).map((part) => graphId(decodeURIComponent(part))).join('/');
	return path ? `/sites/${url.hostname}:/${path}` : `/sites/${url.hostname}`;
}

function mailboxPath(mailbox) {
	return mailbox ? `/users/${graphId(mailbox)}` : '/me';
}

export function calendarRange({ from, to } = {}, now = new Date()) {
	function parse(value) {
		if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
			throw new Error('Calendar dates must use ISO 8601 with a timezone, for example 2026-09-14T09:00:00+03:00.');
		}
		return new Date(value);
	}
	const start = from ? parse(from) : now;
	const end = to ? parse(to) : new Date(start.getTime() + 30 * 86400000);
	if (end <= start || end - start > 366 * 86400000) throw new Error('Calendar end must follow start, within 366 days.');
	return { startDateTime: start.toISOString(), endDateTime: end.toISOString() };
}

function calendarPath({ mailbox, calendar } = {}) {
	return `${mailboxPath(mailbox)}/${calendar ? `calendars/${graphId(calendar)}` : 'calendar'}`;
}

function eventStart(event) {
	const value = event.start?.dateTime || '';
	const start = Date.parse(/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`);
	if (!Number.isFinite(start)) throw new Error('Microsoft Graph returned an event without a valid start time.');
	return start;
}

export function createGraphClient({ fetchImpl = fetch, auth = graphAuth, defaultSite = () => get('graph.defaultSite') } = {}) {
	async function response(path, params = {}, { sharedMail = false, calendars = false, availability = false, headers = {}, scheduleQuery, timeout = 60000 } = {}) {
		const url = graphUrl(path, params);
		if (scheduleQuery && (url.pathname !== '/v1.0/me/calendar/getSchedule' || url.search)) throw new Error('Only the read-only getSchedule query can use POST.');
		const token = await auth.token({ sharedMail, calendars, availability });
		const result = await fetchImpl(url, {
			method: scheduleQuery ? 'POST' : 'GET',
			headers: { ...headers, Accept: 'application/json', Authorization: `Bearer ${token}`, ...(scheduleQuery ? { 'Content-Type': 'application/json' } : {}) },
			...(scheduleQuery ? { body: JSON.stringify(scheduleQuery) } : {}),
			redirect: 'manual',
			signal: AbortSignal.timeout(timeout),
		});
		return result;
	}

	async function check(result) {
		if (result.ok) return;
		let message = `Microsoft Graph request failed (${result.status}).`;
		if (result.status === 401) message = 'Microsoft Graph rejected the sign-in. Run: dev graph login';
		else if (result.status === 403) message = 'Microsoft Graph access denied. Check delegated permissions, administrator consent, and your access to this resource. Shared mail also needs Mail.Read.Shared and Exchange access.';
		else if (result.status === 404) message = 'Microsoft Graph resource not found. Check its ID and your access.';
		else if (result.status === 429) message = `Microsoft Graph rate limit reached. Retry after ${result.headers.get('retry-after') || 'a few'} seconds.`;
		else if (result.status >= 300 && result.status < 400) message = 'Refused an unexpected Microsoft Graph redirect.';
		if (result.headers.get('content-type')?.includes('application/json')) {
			try {
				const body = await result.json();
				const code = body.error?.code;
				if (typeof code === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(code)) message += ` Code: ${code}.`;
			} catch {}
		} else {
			await result.body?.cancel();
		}
		const err = new Error(message);
		err.status = result.status;
		throw err;
	}

	async function request(path, params, options) {
		const result = await response(path, params, options);
		await check(result);
		return result.json();
	}

	async function collection(path, params = {}, { limit = 25, pageSize = 100, requireComplete = false, ...options } = {}) {
		limit = graphLimit(limit);
		let next = graphUrl(path, { ...params, $top: Math.min(limit, pageSize) }).href;
		const seen = new Set();
		const items = [];
		while (next && items.length < limit) {
			if (seen.has(next) || seen.size >= 1000) throw new Error('Microsoft Graph returned invalid pagination.');
			seen.add(next);
			const page = await request(next, {}, options);
			if (!Array.isArray(page.value)) throw new Error('Microsoft Graph returned an invalid collection.');
			const overflow = page.value.length > limit - items.length;
			items.push(...page.value.slice(0, limit - items.length));
			next = page['@odata.nextLink'];
			if (requireComplete && (overflow || (next && items.length >= limit))) throw new Error('Calendar range exceeds 1000 events. Narrow --from and --to.');
		}
		return items;
	}

	async function siteId(site) {
		const target = site || defaultSite();
		if (target && !/^https?:/i.test(target)) return graphId(target);
		const data = await request(siteAddress(target), { $select: 'id' });
		return graphId(data.id);
	}

	async function calendarEvents(options = {}) {
		const range = calendarRange(options);
		// Read the entire bounded window before sorting, so page order cannot hide an earlier occurrence.
		const events = await collection(`${calendarPath(options)}/calendarView`, range, {
			limit: 1000, pageSize: 1000, requireComplete: true, calendars: true, headers: { Prefer: 'outlook.timezone="UTC"' },
		});
		return { range, events: events.sort((a, b) => eventStart(a) - eventStart(b)) };
	}

	return {
		async availability(schedules, options = {}) {
			if (!Array.isArray(schedules) || !schedules.length || schedules.length > 20 || schedules.some((address) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) {
				throw new Error('Supply 1–20 email addresses for the availability query.');
			}
			const range = calendarRange(options);
			if (!options.to) range.endDateTime = new Date(Date.parse(range.startDateTime) + 86400000).toISOString();
			if (Date.parse(range.endDateTime) - Date.parse(range.startDateTime) >= 62 * 86400000) throw new Error('Availability range must be shorter than 62 days.');
			const interval = Number(options.interval ?? 30);
			if (!Number.isInteger(interval) || interval < 5 || interval > 1440) throw new Error('Availability interval must be 5–1440 minutes.');
			const result = await request('/me/calendar/getSchedule', {}, {
				availability: true,
				headers: { Prefer: 'outlook.timezone="UTC"' },
				scheduleQuery: {
					schedules,
					startTime: { dateTime: range.startDateTime.replace(/Z$/, ''), timeZone: 'UTC' },
					endTime: { dateTime: range.endDateTime.replace(/Z$/, ''), timeZone: 'UTC' },
					availabilityViewInterval: interval,
				},
			});
			if (!Array.isArray(result.value)) throw new Error('Microsoft Graph returned an invalid availability result.');
			return { from: range.startDateTime, to: range.endDateTime, intervalMinutes: interval, schedules: result.value };
		},
		calendars: ({ mailbox, limit } = {}) => collection(`${mailboxPath(mailbox)}/calendars`, {}, { limit, calendars: true }),
		calendarEvents: async (options = {}) => {
			const limit = graphLimit(options.limit);
			return (await calendarEvents(options)).events.slice(0, limit);
		},
		nextEvent: async (options = {}) => {
			const { range, events } = await calendarEvents(options);
			const start = Date.parse(range.startDateTime);
			const event = events.find((item) => !item.isCancelled && item.responseStatus?.response !== 'declined' && eventStart(item) >= start) || null;
			return { from: range.startDateTime, to: range.endDateTime, event };
		},
		calendarEvent: (id, options = {}) => request(`${calendarPath(options)}/events/${graphId(id)}`, {}, { calendars: true, headers: { Prefer: 'outlook.timezone="UTC"' } }),

		chats: ({ limit } = {}) => collection('/me/chats', { $expand: 'members', $orderby: 'lastMessagePreview/createdDateTime desc' }, { limit, pageSize: 50 }),
		chat: (id) => request(`/chats/${graphId(id)}`, { $expand: 'members' }),
		chatMessages: (id, { limit } = {}) => collection(`/chats/${graphId(id)}/messages`, { $orderby: 'createdDateTime desc' }, { limit, pageSize: 50 }),
		chatMessage: (chatId, messageId) => request(`/chats/${graphId(chatId)}/messages/${graphId(messageId)}`),

		mailFolders: ({ mailbox, parent, limit } = {}) => collection(`${mailboxPath(mailbox)}/mailFolders${parent ? `/${graphId(parent)}/childFolders` : ''}`, {}, { limit, sharedMail: !!mailbox }),
		mailMessages: ({ mailbox, folder, search, limit } = {}) => {
			const path = `${mailboxPath(mailbox)}${folder ? `/mailFolders/${graphId(folder)}` : ''}/messages`;
			return collection(path, {
				$select: MAIL_FIELDS,
				$search: search ? JSON.stringify(search) : undefined,
				$orderby: search ? undefined : 'receivedDateTime desc',
			}, { limit, sharedMail: !!mailbox });
		},
		mailMessage: (id, { mailbox, folder } = {}) => request(`${mailboxPath(mailbox)}${folder ? `/mailFolders/${graphId(folder)}` : ''}/messages/${graphId(id)}`, {
			$select: `${MAIL_FIELDS},body,ccRecipients`,
		}, { sharedMail: !!mailbox, headers: { Prefer: 'outlook.body-content-type="text"' } }),

		sites: (query, { limit } = {}) => collection('/sites', { search: query, $select: 'id,name,displayName,description,webUrl' }, { limit }),
		site: (site) => request(siteAddress(site || defaultSite()), { $select: 'id,name,displayName,description,webUrl' }),
		drives: async ({ site, limit } = {}) => collection(`/sites/${await siteId(site)}/drives`, {}, { limit }),
		files: (drive, { folder, path, limit } = {}) => {
			if (folder && path) throw new Error('Use either --folder or --path, not both.');
			let location = folder ? `items/${graphId(folder)}` : 'root';
			if (path) location = `root:/${path.replace(/\\/g, '/').split('/').filter(Boolean).map(graphId).join('/')}:`;
			return collection(`/drives/${graphId(drive)}/${location}/children`, {}, { limit });
		},
		file: (drive, id) => request(`/drives/${graphId(drive)}/items/${graphId(id)}`),
		lists: async ({ site, limit } = {}) => collection(`/sites/${await siteId(site)}/lists`, {}, { limit }),
		listItems: async (list, { site, limit } = {}) => collection(`/sites/${await siteId(site)}/lists/${graphId(list)}/items`, { $expand: 'fields' }, { limit }),
		listItem: async (list, item, { site } = {}) => request(`/sites/${await siteId(site)}/lists/${graphId(list)}/items/${graphId(item)}`, { $expand: 'fields' }),

		async download(drive, id, destination, { timeout = 120 } = {}) {
			if (!/^\d+$/.test(String(timeout)) || Number(timeout) < 1 || Number(timeout) > 86400) throw new Error('Download timeout must be 1–86400 seconds.');
			const milliseconds = Number(timeout) * 1000;
			try {
				await lstat(destination);
				throw Object.assign(new Error('Destination already exists. Choose a new local path.'), { code: 'EEXIST' });
			} catch (err) {
				if (err.code !== 'ENOENT') throw err;
			}
			const directory = await mkdtemp(join(dirname(resolve(destination)), '.devtool-download-'));
			const temporary = join(directory, 'content');
			let failure;
			try {
				let result = await response(`/drives/${graphId(drive)}/items/${graphId(id)}/content`, {}, { timeout: milliseconds });
				if (result.status === 302) {
					const target = new URL(result.headers.get('location'));
					await result.body?.cancel();
					if (target.protocol !== 'https:' || !target.hostname.endsWith('.sharepoint.com') || target.username || target.password || target.port) {
						throw new Error('Refused a download redirect outside SharePoint Online.');
					}
					// The download URL already authorizes this request; never forward the Graph bearer token.
					result = await fetchImpl(target, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(milliseconds) });
				}
				await check(result);
				if (!result.body) throw new Error('SharePoint returned no file content.');
				const file = await open(temporary, 'wx', 0o600);
				try {
					await pipeline(Readable.fromWeb(result.body), file.createWriteStream());
				} finally {
					await file.close();
				}
				// Publish only a complete file. An atomic hard link refuses a concurrently created destination.
				await link(temporary, destination);
				return { path: resolve(destination), downloaded: true };
			} catch (err) {
				failure = err;
				throw err;
			} finally {
				try {
					await rm(directory, { recursive: true, force: true });
				} catch (err) {
					if (failure) failure.message += ' Temporary download cleanup failed.';
					else throw new Error('The download is complete, but temporary file cleanup failed.', { cause: err });
				}
			}
		},
	};
}

export const graph = createGraphClient();
