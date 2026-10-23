import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';

const directory = await mkdtemp(join(tmpdir(), 'devtool-graph-test-'));
process.env.APPDATA = join(directory, 'roaming');
process.env.LOCALAPPDATA = join(directory, 'local');
process.env.XDG_CONFIG_HOME = join(directory, 'config');
const { createGraphClient, graphUrl, graphId, graphLimit, siteAddress, calendarRange } = await import('../src/clients/graph.js');
const { createGraphAuth, GRAPH_SCOPES, SHARED_MAIL_SCOPE, CALENDAR_SCOPE, AVAILABILITY_SCOPE, graphIdentity } = await import('../src/clients/graph-auth.js');
const { createGraphCommand, graphErrorMessage } = await import('../src/commands/graph.js');
const { curateMailJson, curateChatMessageJson, curateFileJson, curateNextEventJson, curateAvailabilityJson, formatGraph } = await import('../src/formatters/graph.js');
const { setField, getConnection, validateGraphId, validateGraphSite } = await import('../src/config/store.js');
after(() => rm(directory, { recursive: true, force: true }));

function fixture(pages = [{ value: [] }]) {
	const calls = [];
	const tokens = [];
	const client = createGraphClient({
		auth: { token: async (options) => { tokens.push(options); return 'test-token'; } },
		defaultSite: 'https://example.sharepoint.com/sites/Products',
		fetchImpl: async (url, options) => {
			calls.push({ url: new URL(url), ...options });
			const page = pages.shift();
			assert.notEqual(page, undefined, 'Unexpected request');
			return page instanceof Response ? page : Response.json(page);
		},
	});
	return { client, calls, tokens };
}

async function capture(fn) {
	const stdout = [], stderr = [];
	const log = console.log, error = console.error, exitCode = process.exitCode;
	console.log = (...args) => stdout.push(args.join(' '));
	console.error = (...args) => stderr.push(args.join(' '));
	try {
		await fn();
		return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode: process.exitCode };
	} finally {
		console.log = log;
		console.error = error;
		process.exitCode = exitCode;
	}
}

function program(services) {
	return new Command().option('--json').option('--plain').addCommand(createGraphCommand({ connect: () => services }));
}

test('configuration validates IDs and site URLs without requiring other services', () => {
	assert.throws(() => graphIdentity({}), /dev graph setup/);
	const id = '11111111-1111-1111-1111-111111111111';
	assert.equal(validateGraphId(id), undefined);
	assert.match(validateGraphId('common'), /UUID/);
	assert.deepEqual(graphIdentity({ tenantId: id.toUpperCase(), clientId: id }), { tenantId: id, clientId: id });
	assert.throws(() => setField('graph', 'tenantId', 'common'), /UUID/);
	assert.throws(() => getConnection('graph'), /No Microsoft Graph connection/);
	setField('graph', 'tenantId', ` ${id.toUpperCase()} `);
	setField('graph', 'clientId', id);
	setField('graph', 'defaultSite', 'https://example.sharepoint.com/sites/Products/');
	assert.deepEqual(getConnection('graph'), { type: 'graph', tenantId: id, clientId: id, defaultSite: 'https://example.sharepoint.com/sites/Products' });
	assert.throws(() => setField('graph', 'defaultSite', 'https://example.com'), /SharePoint Online/);
	assert.equal(validateGraphSite('https://example.sharepoint.com/sites/Products'), undefined);
	for (const url of ['http://example.sharepoint.com', 'https://example.com', 'https://example.sharepoint.com@evil.test', 'https://example.sharepoint.com/?secret=1']) {
		assert.ok(validateGraphSite(url));
	}
});

test('Graph URL validation rejects untrusted hosts and version paths', () => {
	for (const url of ['https://evil.test/v1.0/me', 'https://graph.microsoft.com.evil.test/v1.0/me', 'http://graph.microsoft.com/v1.0/me', 'https://name@graph.microsoft.com/v1.0/me', 'https://graph.microsoft.com/beta/me', '/../../me', 'https://graph.microsoft.com/v1.0/me#fragment']) {
		assert.throws(() => graphUrl(url));
	}
	assert.equal(graphUrl('/me/messages', { $search: 'subject:"hello & world"' }).searchParams.get('$search'), 'subject:"hello & world"');
	assert.equal(graphId('a/b?#'), 'a%2Fb%3F%23');
	assert.throws(() => graphId('..'));
});

test('limits reject invalid and unbounded input', () => {
	for (const value of [0, -1, 1001, '2x', '2.5', NaN, Infinity, '']) assert.throws(() => graphLimit(value));
	assert.equal(graphLimit('1000'), 1000);
});

test('collections follow nextLink verbatim and enforce the total limit', async () => {
	const next = 'https://graph.microsoft.com/v1.0/me/chats?$skiptoken=a%2Bb';
	const { client, calls } = fixture([{ value: [{ id: '1' }], '@odata.nextLink': next }, { value: [{ id: '2' }, { id: '3' }, { id: '4' }] }]);
	assert.deepEqual((await client.chats({ limit: 3 })).map((x) => x.id), ['1', '2', '3']);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].url.href, next);
	assert.equal(calls[0].url.searchParams.get('$top'), '3');
	for (const call of calls) {
		assert.equal(call.method, 'GET');
		assert.equal(call.redirect, 'manual');
		assert.equal(call.headers.Authorization, 'Bearer test-token');
	}
});

test('pagination never sends a token to a foreign origin', async () => {
	const { client, calls, tokens } = fixture([{ value: [], '@odata.nextLink': 'https://evil.test/v1.0/me' }]);
	await assert.rejects(client.chats(), /invalid Microsoft Graph URL/);
	assert.equal(calls.length, 1);
	assert.equal(tokens.length, 1);
});

test('pagination rejects cycles and malformed data', async () => {
	const next = 'https://graph.microsoft.com/v1.0/me/chats?page=2';
	const cycle = fixture([{ value: [], '@odata.nextLink': next }, { value: [], '@odata.nextLink': next }]);
	await assert.rejects(cycle.client.chats(), /invalid pagination/);
	await assert.rejects(fixture([{}]).client.chats(), /invalid collection/);
});

test('mail search escapes queries and does not combine search with orderby', async () => {
	const { client, calls, tokens } = fixture();
	await client.mailMessages({ search: 'subject:"release plan"', mailbox: 'shared@example.test', folder: 'inbox' });
	assert.equal(calls[0].url.pathname, '/v1.0/users/shared%40example.test/mailFolders/inbox/messages');
	assert.equal(calls[0].url.searchParams.get('$search'), JSON.stringify('subject:"release plan"'));
	assert.equal(calls[0].url.searchParams.has('$orderby'), false);
	assert.equal(tokens[0].sharedMail, true);
});

test('mail view requests text and only reads the requested folder', async () => {
	const { client, calls, tokens } = fixture([{ id: 'message' }]);
	await client.mailMessage('a/b=', { folder: 'inbox' });
	assert.equal(calls[0].url.pathname, '/v1.0/me/mailFolders/inbox/messages/a%2Fb%3D');
	assert.equal(calls[0].headers.Prefer, 'outlook.body-content-type="text"');
	assert.equal(tokens[0].sharedMail, false);
});

test('availability uses only the read-only schedule POST with bounded inputs', async () => {
	const { client, calls, tokens } = fixture([{ value: [{ scheduleId: 'user@example.test', availabilityView: '2200', scheduleItems: [] }] }]);
	const result = await client.availability(['user@example.test'], { from: '2026-09-14T09:00:00+03:00', to: '2026-09-14T11:00:00+03:00' });
	assert.equal(calls[0].method, 'POST');
	assert.equal(calls[0].url.pathname, '/v1.0/me/calendar/getSchedule');
	assert.equal(calls[0].redirect, 'manual');
	assert.equal(calls[0].headers['Content-Type'], 'application/json');
	assert.equal(tokens[0].availability, true);
	const body = JSON.parse(calls[0].body);
	assert.deepEqual(body.schedules, ['user@example.test']);
	assert.deepEqual(body.startTime, { dateTime: '2026-09-14T06:00:00.000', timeZone: 'UTC' });
	assert.equal(body.availabilityViewInterval, 30);
	assert.equal(result.intervalMinutes, 30);
	await assert.rejects(client.availability([]), /1–20/);
	await assert.rejects(client.availability(['invalid']), /email addresses/);
	await assert.rejects(client.availability(Array(21).fill('user@example.test')), /1–20/);
	await assert.rejects(client.availability(['user@example.test'], { interval: 4 }), /5–1440/);
	await assert.rejects(client.availability(['user@example.test'], { from: '2026-01-01T00:00:00Z', to: '2026-03-04T00:00:00Z' }), /shorter than 62 days/);
	assert.equal(calls.length, 1);
});

test('availability preserves per-person errors and never treats them as free', async () => {
	const data = { from: 'start', to: 'end', intervalMinutes: 30, schedules: [{ scheduleId: 'user@example.test', availabilityView: '000', error: { responseCode: '5006', message: 'Too many entries' } }] };
	assert.equal(curateAvailabilityJson(data).schedules[0].availabilityView, null);
	const output = await capture(() => program({ client: { availability: async () => data } }).parseAsync(['--json', 'graph', 'calendar', 'availability', 'user@example.test'], { from: 'user' }));
	assert.equal(output.exitCode, 1);
	assert.equal(JSON.parse(output.stdout).schedules[0].error.code, '5006');
});

test('next-event JSON has the same envelope with and without an event', () => {
	const base = { from: 'start', to: 'end' };
	assert.equal(curateNextEventJson({ ...base, event: null }).event, null);
	const found = curateNextEventJson({ ...base, event: { id: 'event', subject: 'Meeting' } });
	assert.equal(found.event.id, 'event');
	assert.equal(found.id, undefined);
});

test('calendar dates require a timezone and bound the complete search window', () => {
	const range = calendarRange({ from: '2026-09-14T09:00:00+03:00', to: '2026-09-15T09:00:00+03:00' });
	assert.equal(range.startDateTime, '2026-09-14T06:00:00.000Z');
	assert.equal(range.endDateTime, '2026-09-15T06:00:00.000Z');
	for (const from of ['yesterday', '2026-09-14', '2026-09-14T09:00:00']) assert.throws(() => calendarRange({ from }));
	assert.throws(() => calendarRange({ from: '2026-09-15T00:00:00Z', to: '2026-09-14T00:00:00Z' }));
	assert.throws(() => calendarRange({ from: '2026-09-15T00:00:00Z', to: '2028-09-14T00:00:00Z' }));
});

test('next event expands recurrence and sorts across pages before filtering', async () => {
	const event = (id, hour, extra = {}) => ({ id, start: { dateTime: `2026-09-14T${hour}:00:00.0000000`, timeZone: 'UTC' }, ...extra });
	const { client, calls, tokens } = fixture([
		{ value: [event('late', '18'), event('cancelled', '10', { isCancelled: true })], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendar/calendarView?$skiptoken=2' },
		{ value: [event('ongoing', '07'), event('declined', '09', { responseStatus: { response: 'declined' } }), event('next', '11', { type: 'occurrence' })] },
	]);
	const next = await client.nextEvent({ from: '2026-09-14T08:00:00Z', to: '2026-09-15T00:00:00Z' });
	assert.equal(next.event.id, 'next');
	assert.equal(calls[0].url.pathname, '/v1.0/me/calendar/calendarView');
	assert.equal(calls[0].headers.Prefer, 'outlook.timezone="UTC"');
	assert.equal(calls[0].url.searchParams.get('startDateTime'), '2026-09-14T08:00:00.000Z');
	assert.equal(tokens.every((x) => x.calendars && !x.sharedMail), true);
});

test('next event refuses to guess from an incomplete calendar window', async () => {
	const { client } = fixture([{ value: Array.from({ length: 1000 }, (_, id) => ({ id: String(id) })), '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendar/calendarView?more=1' }]);
	await assert.rejects(client.nextEvent(), /Narrow --from and --to/);
	const empty = await fixture([{ value: [] }]).client.nextEvent();
	assert.equal(empty.event, null);
	assert.ok(empty.from && empty.to);
});

test('shared calendar endpoints use the owner and selected calendar', async () => {
	const { client, calls } = fixture([{ value: [] }, { id: 'event' }]);
	await client.calendars({ mailbox: 'owner@example.test' });
	await client.calendarEvent('event', { mailbox: 'owner@example.test', calendar: 'shared/id' });
	assert.equal(calls[0].url.pathname, '/v1.0/users/owner%40example.test/calendars');
	assert.equal(calls[1].url.pathname, '/v1.0/users/owner%40example.test/calendars/shared%2Fid/events/event');
});

test('calendar event limit applies after chronological sorting', async () => {
	const { client } = fixture([{ value: [{ id: 'late', start: { dateTime: '2026-09-14T12:00:00', timeZone: 'UTC' } }, { id: 'early', start: { dateTime: '2026-09-14T09:00:00', timeZone: 'UTC' } }] }]);
	assert.equal((await client.calendarEvents({ limit: 1 }))[0].id, 'early');
});

test('site URL addressing and default-site library resolution', async () => {
	assert.equal(siteAddress('https://example.sharepoint.com/sites/My%20Site'), '/sites/example.sharepoint.com:/sites/My%20Site');
	assert.equal(siteAddress('https://example.sharepoint.com/'), '/sites/example.sharepoint.com');
	assert.throws(() => siteAddress(''), /defaultSite/);
	const { client, calls } = fixture([{ id: 'example.sharepoint.com,a,b' }, { value: [] }]);
	await client.drives();
	assert.equal(calls[0].url.pathname, '/v1.0/sites/example.sharepoint.com:/sites/Products');
	assert.equal(calls[1].url.pathname, '/v1.0/sites/example.sharepoint.com%2Ca%2Cb/drives');
});

test('library-relative paths encode each segment and reject traversal', async () => {
	const { client, calls } = fixture();
	await client.files('drive', { path: 'Product Data/Documentation/My Product' });
	assert.equal(calls[0].url.pathname, '/v1.0/drives/drive/root:/Product%20Data/Documentation/My%20Product:/children');
	assert.throws(() => client.files('drive', { path: '../private' }));
	assert.throws(() => client.files('drive', { folder: 'folder', path: 'path' }));
});

test('errors expose safe diagnostics for network and API failures', async () => {
	assert.match(graphErrorMessage(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })), /network, VPN, and proxy/);
	assert.match(graphErrorMessage({ name: 'TimeoutError' }), /timed out/);
	assert.match(graphErrorMessage({ cause: { code: 'CERT_HAS_EXPIRED' } }), /certificate/);
	const response = Response.json({ error: { code: 'BadRequest', message: 'private server detail' } }, { status: 400 });
	await assert.rejects(fixture([response]).client.chats(), (err) => err.message.includes('BadRequest') && !err.message.includes('private'));
	assert.ok(validateGraphSite('https://example.sharepoint.com/sites/%ZZ'));
});

test('errors explain authentication, permissions, throttling and redirects', async () => {
	for (const [status, message] of [[401, /dev graph login/], [403, /delegated permissions/], [404, /not found/], [429, /Retry after 12/], [302, /redirect/]]) {
		const { client } = fixture([new Response('', { status, headers: { 'retry-after': '12' } })]);
		await assert.rejects(client.chats(), message);
	}
});

test('download follows a SharePoint URL without bearer credentials and refuses overwrite', async () => {
	const destination = join(directory, 'download.txt');
	const { client, calls } = fixture([
		new Response(null, { status: 302, headers: { location: 'https://example.sharepoint.com/download?token=secret' } }),
		new Response('file content'),
	]);
	assert.equal((await client.download('drive', 'item', destination)).downloaded, true);
	assert.equal(await readFile(destination, 'utf8'), 'file content');
	assert.equal(calls[1].headers, undefined);
	assert.equal(calls[1].redirect, 'error');
	await assert.rejects(client.download('drive', 'item', destination), { code: 'EEXIST' });
	assert.equal(calls.length, 2);
	assert.equal(await readFile(destination, 'utf8'), 'file content');
});

test('downloads expose no partial destination and preserve a concurrent file', async () => {
	const destination = join(directory, 'concurrent.txt');
	const client = createGraphClient({
		auth: { token: async () => 'test-token' },
		fetchImpl: async () => {
			await assert.rejects(stat(destination), { code: 'ENOENT' });
			await writeFile(destination, 'concurrent content');
			return new Response('downloaded content');
		},
	});
	await assert.rejects(client.download('drive', 'item', destination, { timeout: 3600 }), { code: 'EEXIST' });
	assert.equal(await readFile(destination, 'utf8'), 'concurrent content');
	await assert.rejects(client.download('drive', 'item', destination, { timeout: 0 }), /timeout must/);
});

test('failed downloads remove only the file created by this request', async () => {
	const destination = join(directory, 'failed.txt');
	const { client, calls } = fixture([new Response(null, { status: 302, headers: { location: 'https://evil.test/file' } })]);
	await assert.rejects(client.download('drive', 'item', destination), /outside SharePoint/);
	await assert.rejects(stat(destination), { code: 'ENOENT' });
	assert.equal(calls.length, 1);
});

function authFixture(accounts = []) {
	const state = { accounts, silent: [], interactive: [], removed: [] };
	const cache = { getAllAccounts: async () => state.accounts, removeAccount: async (a) => { state.removed.push(a); state.accounts = state.accounts.filter((x) => x !== a); } };
	const app = {
		getTokenCache: () => cache,
		acquireTokenSilent: async (options) => { state.silent.push(options); if (state.failure) throw state.failure; return { accessToken: 'token' }; },
		acquireTokenInteractive: async (options) => { state.interactive.push(options); return { account: state.loginAccount }; },
	};
	return { auth: createGraphAuth({ applicationFactory: async () => app, browserOpener: async () => {} }), state };
}

const user = { username: 'user@example.test', name: 'Example', homeAccountId: 'home', tenantId: 'tenant' };

test('Windows persistence encrypts the cache and survives a new instance', { skip: process.platform !== 'win32' }, async () => {
	const { PersistenceCreator, DataProtectionScope } = await import('@azure/msal-node-extensions');
	const options = {
		cachePath: join(directory, 'protected-cache.bin'),
		dataProtectionScope: DataProtectionScope.CurrentUser,
		serviceName: 'devtool-graph-test',
		accountName: 'temporary-test',
		usePlaintextFileOnLinux: false,
	};
	const marker = 'not-a-real-token-cache-test';
	const cache = await PersistenceCreator.createPersistence(options);
	await cache.save(marker);
	assert.equal((await readFile(options.cachePath)).includes(Buffer.from(marker)), false);
	const restored = await PersistenceCreator.createPersistence(options);
	assert.equal(await restored.load(), marker);
});

test('silent auth never starts a browser or chooses an arbitrary account', async () => {
	for (const accounts of [[], [user, { ...user, homeAccountId: 'other' }]]) {
		const { auth, state } = authFixture(accounts);
		await assert.rejects(auth.token(), /dev graph login/);
		assert.equal(state.interactive.length, 0);
	}
});

test('all features share auth while shared-mail consent is optional', async () => {
	const { auth, state } = authFixture([user]);
	await auth.token();
	assert.deepEqual(state.silent[0].scopes, GRAPH_SCOPES);
	await auth.token({ sharedMail: true });
	assert.deepEqual(state.silent[1].scopes, [...GRAPH_SCOPES, SHARED_MAIL_SCOPE]);
	await auth.token({ calendars: true });
	assert.deepEqual(state.silent[2].scopes, [...GRAPH_SCOPES, CALENDAR_SCOPE, AVAILABILITY_SCOPE]);
	state.loginAccount = user;
	await auth.login({ sharedMail: true, calendars: true });
	assert.deepEqual(state.interactive[0].scopes, [...GRAPH_SCOPES, SHARED_MAIL_SCOPE, CALENDAR_SCOPE, AVAILABILITY_SCOPE]);
	await auth.login({ all: true });
	assert.deepEqual(state.interactive[1].scopes, state.interactive[0].scopes);
	await auth.token({ availability: true });
	assert.deepEqual(state.silent[3].scopes, [...GRAPH_SCOPES, AVAILABILITY_SCOPE]);
	state.interactive = [];
	state.failure = { errorCode: 'interaction_required' };
	await assert.rejects(auth.token({ sharedMail: true }), /login --shared-mail/);
	assert.equal(state.interactive.length, 0);
});

test('login chooses one account and logout removes the local account', async () => {
	const previous = { ...user, homeAccountId: 'old' };
	const { auth, state } = authFixture([user, previous]);
	state.loginAccount = user;
	assert.equal((await auth.login()).username, user.username);
	assert.deepEqual(state.removed, [previous]);
	assert.equal((await auth.status()).cached, true);
	await auth.logout();
	assert.equal(state.accounts.length, 0);
});

test('curated output excludes raw metadata and preauthenticated download URLs', () => {
	const file = curateFileJson({ id: '1', name: 'file', file: {}, '@microsoft.graph.downloadUrl': 'secret', '@odata.context': 'raw' });
	assert.equal(JSON.stringify(file).includes('secret'), false);
	const mail = curateMailJson({ id: '2', body: { contentType: 'html', content: '<p>Hello &amp; goodbye</p><script>bad()</script>' } });
	assert.equal(mail.body, 'Hello & goodbye');
	assert.equal(curateChatMessageJson({ body: { contentType: 'text', content: '\x1b[31mhello\x1b[0m' } }).body, 'hello');
});

test('plain output strips terminal controls; JSON remains parseable and curated', async () => {
	const plain = await capture(() => formatGraph({ subject: '\x1b[31mhello\x1b[0m\x07' }, { mode: 'plain' }));
	assert.equal(plain.stdout, 'subject: hello');
	const json = await capture(() => formatGraph([], { mode: 'json' }));
	assert.deepEqual(JSON.parse(json.stdout), []);
});

test('CLI passes inherited options and IDs to the shared client', async () => {
	let request;
	const cli = program({ client: { mailMessages: async (options) => { request = options; return [{ id: '1', subject: 'Test' }]; } } });
	const output = await capture(() => cli.parseAsync(['--json', 'graph', 'mail', '--mailbox', 'shared@example.test', 'list', '--folder', 'inbox', '--limit', '2'], { from: 'user' }));
	assert.equal(request.mailbox, 'shared@example.test');
	assert.equal(request.limit, 2);
	assert.equal(request.folder, 'inbox');
	assert.equal(JSON.parse(output.stdout)[0].subject, 'Test');
	assert.equal(output.stderr, '');
});

test('all read commands route to the expected client method and curate JSON', async () => {
	const cases = [
		[['calendar', 'list'], 'calendars', true],
		[['calendars', 'events'], 'calendarEvents', true],
		[['calendar', 'view', 'event'], 'calendarEvent'],
		[['teams', 'chats'], 'chats', true],
		[['teams', 'view', 'chat'], 'chat'],
		[['teams', 'messages', 'chat'], 'chatMessages', true],
		[['teams', 'message', 'chat', 'message'], 'chatMessage'],
		[['mail', 'folders'], 'mailFolders', true],
		[['email', 'search', 'query'], 'mailMessages', true],
		[['mail', 'view', 'message'], 'mailMessage'],
		[['sharepoint', 'sites', 'query'], 'sites', true],
		[['sharepoint', 'site'], 'site'],
		[['sp', 'libraries'], 'drives', true],
		[['sharepoint', 'files', 'drive'], 'files', true],
		[['sharepoint', 'file', 'drive', 'item'], 'file'],
		[['sharepoint', 'lists'], 'lists', true],
		[['sharepoint', 'items', 'list'], 'listItems', true],
		[['sharepoint', 'item', 'list', 'item'], 'listItem'],
	];
	for (const [args, method, isList] of cases) {
		let called = false;
		const client = { [method]: async () => { called = true; return isList ? [{ id: 'fixture' }] : { id: 'fixture' }; } };
		const output = await capture(() => program({ client }).parseAsync(['--json', 'graph', ...args], { from: 'user' }));
		assert.equal(output.stderr, '', args.join(' '));
		assert.equal(called, true, method);
		const parsed = JSON.parse(output.stdout);
		assert.equal((isList ? parsed[0] : parsed).id, 'fixture');
	}
});

test('plain lists stay compact and rich lists use tables', async () => {
	const data = [{ id: '123', name: 'Test\nName' }];
	const columns = [['ID', (x) => x.id], ['Name', (x) => x.name]];
	const plain = await capture(() => formatGraph(data, { mode: 'plain', columns }));
	assert.equal(plain.stdout, '123\tTest Name');
	const rich = await capture(() => formatGraph(data, { mode: 'rich', title: 'Files', columns }));
	assert.match(rich.stdout, /Files/);
	assert.match(rich.stdout, /123/);
	assert.match(rich.stdout, /─/);
});

test('rich output preserves full resource IDs that cannot fit a table', async () => {
	const id = `AAMk${'x'.repeat(160)}`;
	const output = await capture(() => formatGraph([{ id, name: 'Message' }], {
		mode: 'rich', title: 'Email', columns: [['ID', (x) => x.id, 36], ['Name', (x) => x.name, 44]],
	}));
	assert.ok(output.stdout.includes(id));
	assert.equal(output.stdout.includes('…'), false);
});

test('CLI puts JSON errors on stderr and returns failure', async () => {
	const cli = program({ client: { chats: async () => { throw new Error('Denied'); } } });
	const output = await capture(() => cli.parseAsync(['--json', 'graph', 'teams', 'chats'], { from: 'user' }));
	assert.equal(output.stdout, '');
	assert.equal(JSON.parse(output.stderr).error.message, 'Denied');
	assert.equal(output.exitCode, 1);
});

test('Graph works without the unrelated first-run wizard and noninteractive login never opens a browser', async () => {
	const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
	const version = spawnSync(process.execPath, ['src/index.js', '--version'], { encoding: 'utf8' });
	assert.equal(version.stdout.trim(), manifest.version);
	const help = spawnSync(process.execPath, ['src/index.js', 'graph', 'sharepoint', '--help'], { encoding: 'utf8' });
	assert.equal(help.status, 0);
	assert.match(help.stdout, /libraries/);
	const login = spawnSync(process.execPath, ['src/index.js', '--json', 'graph', 'login'], { encoding: 'utf8' });
	assert.equal(login.status, 1);
	assert.equal(login.stdout, '');
	assert.match(JSON.parse(login.stderr).error.message, /interactive terminal/);
	for (const args of [['mail', 'list', '--limit', '0'], ['sharepoint', 'files']]) {
		const invalid = spawnSync(process.execPath, ['src/index.js', '--json', 'graph', ...args], { encoding: 'utf8' });
		assert.equal(invalid.status, 1);
		assert.equal(invalid.stdout, '');
		assert.ok(JSON.parse(invalid.stderr).error.message);
	}
	const missing = spawnSync(process.execPath, ['src/index.js', '--json', 'graph', 'teams', 'chats', '--connection', 'nope'], { encoding: 'utf8' });
	assert.equal(missing.status, 1);
	assert.match(JSON.parse(missing.stderr).error.message, /No connection named "nope"/);
	setField('graph', 'clientId', '22222222-2222-2222-2222-222222222222');
	const config = spawnSync(process.execPath, ['src/index.js', 'config', 'show'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
	assert.equal(config.status, 0);
	assert.match(config.stdout, /graph \(Microsoft Graph\)/);
	assert.match(config.stdout, /Client ID: 22222222-2222-2222-2222-222222222222/);
});
