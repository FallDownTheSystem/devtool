import { stripVTControlCharacters } from 'node:util';
import { createRequire } from 'node:module';
import { table, heading, field } from '../utils/output.js';
import { outputJson } from '../utils/mode.js';

const require = createRequire(import.meta.url);
let convert;

export function graphText(value) {
	return stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

function bodyText(body) {
	if (!body) return '';
	if (body.contentType?.toLowerCase() !== 'html') return graphText(body.content);
	convert ||= require('html-to-text').convert;
	return graphText(convert(body.content || '', { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] }));
}

function person(recipient) {
	return recipient ? { name: recipient.emailAddress?.name || null, address: recipient.emailAddress?.address || null } : null;
}

function people(recipients) {
	return (recipients || []).map(person);
}

export function curateCalendarJson(calendar) {
	return {
		id: calendar.id,
		name: calendar.name || '',
		owner: calendar.owner || null,
		isDefault: calendar.isDefaultCalendar ?? false,
		canViewPrivateItems: calendar.canViewPrivateItems ?? false,
	};
}

export function curateEventJson(event) {
	return {
		id: event.id,
		subject: event.subject || '',
		start: event.start || null,
		end: event.end || null,
		isAllDay: event.isAllDay ?? false,
		isCancelled: event.isCancelled ?? false,
		response: event.responseStatus?.response || null,
		organizer: person(event.organizer),
		attendees: (event.attendees || []).map((a) => ({ ...person(a), type: a.type || null, response: a.status?.response || null })),
		location: event.location?.displayName || null,
		type: event.type || null,
		seriesId: event.seriesMasterId || null,
		body: bodyText(event.body),
		joinUrl: event.onlineMeeting?.joinUrl || null,
		url: event.webLink || null,
	};
}

export function curateNextEventJson(result) {
	return {
		from: result.from,
		to: result.to,
		event: result.event ? curateEventJson(result.event) : null,
	};
}

export function curateAvailabilityJson(result) {
	return {
		from: result.from, to: result.to, intervalMinutes: result.intervalMinutes,
		legend: { 0: 'free or working elsewhere', 1: 'tentative', 2: 'busy', 3: 'out of office' },
		schedules: result.schedules.map((schedule) => ({
			address: schedule.scheduleId,
			error: schedule.error ? { code: schedule.error.responseCode || null, message: schedule.error.message || 'Availability is unknown.' } : null,
			availabilityView: schedule.error ? null : schedule.availabilityView ?? null,
			items: (schedule.scheduleItems || []).map((item) => ({
				status: item.status || 'unknown', start: item.start || null, end: item.end || null,
				subject: item.subject || null, location: item.location || null, isPrivate: item.isPrivate ?? null,
			})),
		})),
	};
}

export function formatNextEvent(data, options) {
	if (options.mode === 'json') { outputJson(data); return; }
	formatGraph(data.event ? { from: data.from, to: data.to, ...data.event } : {
		from: data.from, to: data.to, message: 'No upcoming event found in this calendar and date range.',
	}, options);
}

export function formatAvailability(data, options) {
	if (options.mode === 'json') { outputJson(data); return; }
	console.log(`Window: ${data.from} to ${data.to} (UTC; ${data.intervalMinutes}-minute slots)`);
	for (const schedule of data.schedules) {
		formatGraph(schedule, { ...options, title: `Availability: ${schedule.address}` });
	}
	console.log('Slot codes: 0=free/working elsewhere, 1=tentative, 2=busy, 3=out of office. Errors mean unknown, not free.');
}

export function curateChatJson(chat) {
	return {
		id: chat.id,
		topic: chat.topic || null,
		type: chat.chatType || null,
		members: (chat.members || []).map((m) => ({ id: m.userId || m.id, name: m.displayName || null, email: m.email || null })),
		createdAt: chat.createdDateTime || null,
		updatedAt: chat.lastUpdatedDateTime || null,
		url: chat.webUrl || null,
	};
}

export function curateChatMessageJson(message) {
	return {
		id: message.id,
		chatId: message.chatId || null,
		type: message.messageType || null,
		from: message.from?.user?.displayName || message.from?.application?.displayName || null,
		createdAt: message.createdDateTime || null,
		editedAt: message.lastEditedDateTime || null,
		deletedAt: message.deletedDateTime || null,
		body: bodyText(message.body),
		attachments: (message.attachments || []).map((a) => ({ id: a.id, name: a.name || null, type: a.contentType || null })),
		url: message.webUrl || null,
	};
}

export function curateMailJson(message) {
	return {
		id: message.id,
		subject: message.subject || '',
		from: person(message.from),
		to: people(message.toRecipients),
		...(message.ccRecipients ? { cc: people(message.ccRecipients) } : {}),
		receivedAt: message.receivedDateTime || null,
		sentAt: message.sentDateTime || null,
		isRead: message.isRead ?? null,
		hasAttachments: message.hasAttachments ?? false,
		folderId: message.parentFolderId || null,
		preview: message.bodyPreview || '',
		...(message.body ? { body: bodyText(message.body) } : {}),
		url: message.webLink || null,
	};
}

export function curateFolderJson(folder) {
	return { id: folder.id, name: folder.displayName || '', total: folder.totalItemCount ?? 0, unread: folder.unreadItemCount ?? 0, childFolders: folder.childFolderCount ?? 0 };
}

export function curateSiteJson(site) {
	return { id: site.id, name: site.displayName || site.name || '', description: site.description || '', url: site.webUrl || null };
}

export function curateDriveJson(drive) {
	return { id: drive.id, name: drive.name || '', type: drive.driveType || null, description: drive.description || '', url: drive.webUrl || null };
}

export function curateFileJson(file) {
	return {
		id: file.id,
		name: file.name || '',
		type: file.folder ? 'folder' : file.file ? 'file' : 'item',
		size: file.size ?? null,
		mimeType: file.file?.mimeType || null,
		childCount: file.folder?.childCount ?? null,
		driveId: file.parentReference?.driveId || null,
		parentId: file.parentReference?.id || null,
		updatedAt: file.lastModifiedDateTime || null,
		url: file.webUrl || null,
	};
}

export function curateListJson(list) {
	return { id: list.id, name: list.displayName || list.name || '', description: list.description || '', template: list.list?.template || null, url: list.webUrl || null };
}

export function curateListItemJson(item) {
	return {
		id: item.id,
		fields: Object.fromEntries(Object.entries(item.fields || {}).filter(([key]) => !key.startsWith('@odata.'))),
		createdAt: item.createdDateTime || null,
		updatedAt: item.lastModifiedDateTime || null,
		url: item.webUrl || null,
	};
}

function display(value) {
	if (value === null || value === undefined) return '';
	return graphText(typeof value === 'object' ? JSON.stringify(value) : value);
}

export function formatGraph(data, { mode, title, columns = [], records = false }) {
	if (mode === 'json') { outputJson(data); return; }
	const items = Array.isArray(data) ? data : [data];
	if (!items.length) { console.log('No results found.'); return; }
	if (mode === 'rich') heading(graphText(title));
	if (Array.isArray(data) && !records) {
		const rows = items.map((item) => columns.map(([, value]) => display(value(item))));
		if (mode === 'plain') {
			for (const row of rows) console.log(row.map((cell) => cell.replace(/\s+/g, ' ')).join('\t'));
		} else {
			const widths = columns.map(([, , width]) => width || 32);
			const fits = widths.reduce((sum, width) => sum + width, columns.length + 1) <= (process.stdout.columns || 120)
				&& rows.every((row) => row.every((cell, index) => cell.split('\n').every((line) => line.length <= widths[index] - 2)));
			if (fits) console.log(table(columns.map(([label]) => label), rows, { colWidths: widths }));
			else {
				// Resource IDs must remain complete and copyable when a table would truncate them.
				for (const row of rows) {
					for (const [index, cell] of row.entries()) field(columns[index][0], cell);
					console.log('');
				}
			}
		}
		return;
	}
	for (const [index, item] of items.entries()) {
		if (index) console.log('');
		for (const [key, value] of Object.entries(item)) {
			if (mode === 'rich') field(key, display(value));
			else console.log(`${key}: ${display(value)}`);
		}
	}
}
