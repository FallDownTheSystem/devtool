import { Command, InvalidArgumentError } from 'commander';
import { graph as defaultClient, graphLimit } from '../clients/graph.js';
import { graphAuth } from '../clients/graph-auth.js';
import { runGraphSetup } from '../config/store.js';
import { getOutputMode } from '../utils/mode.js';
import { spinner } from '../utils/output.js';
import {
	formatGraph, graphText, curateChatJson, curateChatMessageJson, curateMailJson,
	curateFolderJson, curateSiteJson, curateDriveJson, curateFileJson, curateListJson, curateListItemJson,
	curateCalendarJson, curateEventJson, curateNextEventJson, curateAvailabilityJson, formatNextEvent, formatAvailability,
} from '../formatters/graph.js';

function limit(value) {
	try { return graphLimit(value); }
	catch (err) { throw new InvalidArgumentError(err.message); }
}

export function graphErrorMessage(err) {
	const code = err.cause?.code || err.code;
	if (err.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return 'Microsoft Graph request timed out. Check your connection; for a slow file download, increase --timeout.';
	if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return `Cannot reach Microsoft Graph (${code}). Check your network, VPN, and proxy settings.`;
	if (['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) return 'Microsoft Graph TLS certificate validation failed. Check the certificate chain and your proxy configuration.';
	if (err.cause?.message === 'unexpected redirect') return 'Refused an additional SharePoint download redirect.';
	if (err.cause && code && /^[a-z0-9_.-]{1,80}$/i.test(code)) return `Microsoft Graph connection failed (${code}). Check your network and proxy settings.`;
	return graphText(err.message || 'Microsoft Graph request failed.');
}

export function createGraphCommand({ client = defaultClient, auth = graphAuth, setup = runGraphSetup } = {}) {
	const graph = new Command('graph').description('Read Microsoft Graph: Teams, email, calendars, and SharePoint')
		.configureOutput({ writeErr: (text) => {
			const message = graphText(text).trim();
			process.stderr.write(getOutputMode(graph) === 'json' ? `${JSON.stringify({ error: { message, status: null } })}\n` : `${message}\n`);
		} });
	const calendar = graph.command('calendar').alias('calendars').description('Read your calendars and accessible shared calendars')
		.option('--mailbox <address>', 'Calendar owner address or user ID; requires existing calendar access')
		.option('--calendar <id>', 'Calendar ID from list; defaults to the primary calendar');
	const teams = graph.command('teams').description('Read your Teams chats (not channel messages)');
	const mail = graph.command('mail').alias('email').description('Read email and folders')
		.option('--mailbox <address>', 'Shared mailbox or folder owner; requires Mail.Read.Shared and Exchange access');
	const sharepoint = graph.command('sharepoint').alias('sp').description('Read SharePoint sites, libraries, files, and lists')
		.option('--site <url-or-id>', 'Override graph.defaultSite');

	function action(command, title, load, { curate = (value) => value, format = formatGraph, columns, records = false, interactive = false } = {}) {
		command.action(async function (...args) {
			const mode = getOutputMode(this);
			const s = mode === 'rich' && !interactive ? spinner(title).start() : null;
			try {
				if (interactive && (mode !== 'rich' || !process.stdin.isTTY || !process.stdout.isTTY)) {
					throw new Error('Setup and sign-in require an interactive terminal without --json or --plain. Data commands never open a browser.');
				}
				const result = await load(args, this.optsWithGlobals());
				const data = Array.isArray(result) ? result.map(curate) : curate(result);
				s?.success();
				if (data !== undefined) format(data, { mode, title, columns, records });
			} catch (err) {
				s?.error();
				const message = graphErrorMessage(err);
				console.error(mode === 'json' ? JSON.stringify({ error: { message, status: err.status || null } }) : message);
				process.exitCode = 1;
			}
		});
		return command;
	}

	const bounded = (command) => command.option('-n, --limit <count>', 'Maximum results (1-1000; more results may exist)', limit, 25);
	const mailFolder = (command) => command.option('--folder <id-or-name>', 'Folder ID or well-known name such as inbox');
	const idName = [['ID', (x) => x.id, 38], ['Name', (x) => x.name, 48]];

	action(graph.command('setup').description('Configure the shared tenant ID, client ID, and default SharePoint site'), 'Graph setup', () => setup(), { interactive: true });
	action(graph.command('login').description('Sign in through your browser; no client secret')
		.option('--shared-mail', 'Also request Mail.Read.Shared for shared mailboxes and folders')
		.option('--calendars', 'Also request calendar details and free/busy permissions')
		.option('--all', 'Sign in once for all supported read-only services, including shared email and calendars'), 'Graph sign-in', (_, opts) => auth.login(opts), { interactive: true });
	action(graph.command('status').description('Show the locally cached account (does not check token validity)'), 'Cached Graph account', () => auth.status());
	action(graph.command('logout').description('Remove this application’s local cached account; does not revoke server grants'), 'Graph sign-out', () => auth.logout());

	const dateWindow = (command) => command
		.option('--from <datetime>', 'ISO start with timezone; defaults to now')
		.option('--to <datetime>', 'ISO end with timezone; defaults to 30 days after start (maximum 366 days)');
	action(bounded(calendar.command('list').description('List your calendars, including shared calendars added to your mailbox')), 'Calendars', (_, opts) => client.calendars(opts), {
		curate: curateCalendarJson, columns: [...idName, ['Owner', (x) => x.owner?.address, 32]],
	});
	action(bounded(dateWindow(calendar.command('events').description('Read recurring occurrences and appointments in a date range, in UTC'))), 'Calendar events', (_, opts) => client.calendarEvents(opts), {
		curate: curateEventJson,
		columns: [['ID', (x) => x.id, 32], ['Subject', (x) => x.subject, 44], ['Start (UTC)', (x) => x.start?.dateTime, 30], ['Location', (x) => x.location, 28]],
	});
	action(dateWindow(calendar.command('next').description('Show the next event in the selected calendar; skip cancelled, declined, and already-started events')), 'Next calendar event', (_, opts) => client.nextEvent(opts), { curate: curateNextEventJson, format: formatNextEvent });
	action(calendar.command('availability <addresses...>').description('Read free/busy times for users or rooms; no calendar changes')
		.option('--from <datetime>', 'ISO start with timezone; defaults to now')
		.option('--to <datetime>', 'ISO end with timezone; defaults to 24 hours later (range under 62 days)')
		.option('--interval <minutes>', 'Slot size, 5–1440 minutes', '30'), 'Calendar availability', async ([addresses], opts) => {
			if (opts.mailbox || opts.calendar) throw new Error('Availability uses the supplied email addresses, not --mailbox or --calendar.');
			const result = await client.availability(addresses, opts);
			if (result.schedules.some((schedule) => schedule.error)) process.exitCode = 1;
			return result;
		}, { curate: curateAvailabilityJson, format: formatAvailability });
	action(calendar.command('view <event-id>').description('Read an event from the selected calendar'), 'Calendar event', ([id], opts) => client.calendarEvent(id, opts), { curate: curateEventJson });

	action(bounded(teams.command('chats').alias('list').description('List your chats; expanded members may be limited to 25')), 'Teams chats', (_, opts) => client.chats(opts), {
		curate: curateChatJson,
		columns: [['ID', (x) => x.id, 42], ['Topic / members', (x) => x.topic || x.members.map((m) => m.name || m.email).join(', '), 48], ['Type', (x) => x.type, 16]],
	});
	action(teams.command('view <chat-id>').description('Show a chat and its members'), 'Teams chat', ([id]) => client.chat(id), { curate: curateChatJson });
	action(bounded(teams.command('messages <chat-id>').description('Read chat messages, newest first')), 'Teams messages', ([id], opts) => client.chatMessages(id, opts), { curate: curateChatMessageJson, records: true });
	action(teams.command('message <chat-id> <message-id>').description('Read one chat message'), 'Teams message', ([chat, message]) => client.chatMessage(chat, message), { curate: curateChatMessageJson });

	action(bounded(mail.command('folders').description('List mailbox folders')
		.option('--parent <folder-id>', 'List child folders of this folder')), 'Mail folders', (_, opts) => client.mailFolders(opts), {
		curate: curateFolderJson, columns: [...idName, ['Unread / total', (x) => `${x.unread} / ${x.total}`, 18]],
	});
	const mailColumns = [['ID', (x) => x.id, 36], ['Subject', (x) => x.subject, 44], ['From', (x) => x.from?.address, 30], ['Received', (x) => x.receivedAt, 26]];
	action(bounded(mailFolder(mail.command('list').alias('messages').description('List email across all folders, newest first; use --folder inbox for the inbox'))), 'Email', (_, opts) => client.mailMessages(opts), { curate: curateMailJson, columns: mailColumns });
	action(bounded(mailFolder(mail.command('search <query>').description('Search email using Microsoft message search syntax'))), 'Email search', ([search], opts) => client.mailMessages({ ...opts, search }), { curate: curateMailJson, columns: mailColumns });
	action(mailFolder(mail.command('view <message-id>').description('Read email content without changing its read status')), 'Email message', ([id], opts) => client.mailMessage(id, opts), { curate: curateMailJson });

	action(bounded(sharepoint.command('sites <query>').description('Find sites by text')), 'SharePoint sites', ([query], opts) => client.sites(query, opts), { curate: curateSiteJson, columns: idName });
	action(sharepoint.command('site [url-or-id]').description('Show a site; defaults to graph.defaultSite'), 'SharePoint site', ([site], opts) => client.site(site || opts.site), { curate: curateSiteJson });
	action(bounded(sharepoint.command('libraries').alias('drives').description('List the site’s document libraries')), 'Document libraries', (_, opts) => client.drives(opts), { curate: curateDriveJson, columns: idName });
	action(bounded(sharepoint.command('files <drive-id>').description('List files and folders in a document library')
		.option('--folder <item-id>', 'Folder item ID')
		.option('--path <path>', 'Folder path relative to the library root')), 'SharePoint files', ([drive], opts) => client.files(drive, opts), {
		curate: curateFileJson, columns: [...idName, ['Type', (x) => x.type, 12], ['Bytes', (x) => x.size, 14]],
	});
	action(sharepoint.command('file <drive-id> <item-id>').description('Show file or folder metadata'), 'SharePoint file', ([drive, id]) => client.file(drive, id), { curate: curateFileJson });
	action(sharepoint.command('download <drive-id> <item-id> <destination>').description('Download a file to a new local path; never overwrite')
		.option('--timeout <seconds>', 'Per-request download timeout, 1–86400 seconds', '120'), 'SharePoint download', ([drive, id, destination], opts) => client.download(drive, id, destination, opts));
	action(bounded(sharepoint.command('lists').description('List SharePoint lists')), 'SharePoint lists', (_, opts) => client.lists(opts), { curate: curateListJson, columns: idName });
	action(bounded(sharepoint.command('items <list-id>').description('Read list items and their fields')), 'SharePoint list items', ([list], opts) => client.listItems(list, opts), { curate: curateListItemJson, records: true });
	action(sharepoint.command('item <list-id> <item-id>').description('Read one list item and its fields'), 'SharePoint list item', ([list, item], opts) => client.listItem(list, item, opts), { curate: curateListItemJson });
	return graph;
}

export default createGraphCommand();
