import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { coerceFieldValue, findField, readable, requestedFields, metaList, missingRequired, collectPages } from '../src/utils/jiraFields.js';
import { getCreateMeta as serverCreateMeta } from '../src/clients/jira.js';
import { getCreateMeta as cloudCreateMeta } from '../src/clients/serviceDesk.js';

const server = { user: (name) => ({ name }) };
const cloud = { user: (accountId) => ({ accountId }) };

const schemas = {
	text: { id: 'customfield_1', name: 'Text', schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' } },
	points: { id: 'customfield_2', name: 'Story Points', schema: { type: 'number' } },
	choice: { id: 'customfield_3', name: 'Severity', schema: { type: 'option' }, allowedValues: [{ id: '10', value: 'High' }, { id: '11', value: 'Low' }] },
	openChoice: { id: 'customfield_4', name: 'Open', schema: { type: 'option' } },
	owner: { id: 'customfield_5', name: 'Owner', schema: { type: 'user' } },
	tags: { id: 'customfield_6', name: 'Tags', schema: { type: 'array', items: 'string' } },
	multi: { id: 'customfield_7', name: 'Multi', schema: { type: 'array', items: 'option' }, allowedValues: [{ id: '1', value: 'Red' }, { id: '2', value: 'Blue' }] },
	account: { id: 'customfield_15300', name: 'Account', schema: { type: 'option2', custom: 'com.tempoplugin.tempo-accounts:accounts.customfield', customId: 15300 } },
	priority: { id: 'priority', name: 'Priority', schema: { type: 'priority' }, allowedValues: [{ id: '3', name: 'Major' }] },
};

test('values are coerced to what each field schema expects', () => {
	assert.equal(coerceFieldValue(schemas.text, '23533', server), '23533');
	assert.equal(coerceFieldValue(schemas.points, '5', server), 5);
	assert.equal(coerceFieldValue(schemas.points, '2.5', server), 2.5);
	assert.deepEqual(coerceFieldValue(schemas.choice, 'high', server), { id: '10' });
	assert.deepEqual(coerceFieldValue(schemas.choice, '11', server), { id: '11' });
	assert.deepEqual(coerceFieldValue(schemas.openChoice, 'Anything', server), { value: 'Anything' });
	assert.deepEqual(coerceFieldValue(schemas.owner, 'jdoe', server), { name: 'jdoe' });
	assert.deepEqual(coerceFieldValue(schemas.owner, '5b10ac8d', cloud), { accountId: '5b10ac8d' });
	assert.deepEqual(coerceFieldValue(schemas.tags, 'a, b,,c', server), ['a', 'b', 'c']);
	assert.deepEqual(coerceFieldValue(schemas.multi, 'red,2', server), [{ id: '1' }, { id: '2' }]);
	assert.deepEqual(coerceFieldValue(schemas.priority, 'major', server), { id: '3' });
	// A plugin field takes the text of its ID as a string, never a number.
	assert.equal(coerceFieldValue(schemas.account, '23533', server), '23533');
});

test('explicit JSON is sent unchanged', () => {
	assert.deepEqual(coerceFieldValue(schemas.account, '{"id":23533}', server), { id: 23533 });
	assert.equal(coerceFieldValue(schemas.points, '"5"', server), '5');
	assert.deepEqual(coerceFieldValue(schemas.tags, '["x,y"]', server), ['x,y']);
	assert.equal(coerceFieldValue(schemas.owner, 'null', server), null);
	assert.throws(() => coerceFieldValue(schemas.text, '{oops', server), /not valid JSON/);
});

test('a value that does not fit names the field, its type, and allowed values', () => {
	assert.throws(() => coerceFieldValue(schemas.points, 'five', server), /Story Points \(customfield_2\) has type number; "five" is not a number/);
	assert.throws(() => coerceFieldValue(schemas.choice, 'Medium', server), /Severity \(customfield_3\) has type option; "Medium" does not fit it\. Allowed values: High, Low\./);
	assert.throws(() => coerceFieldValue(schemas.multi, 'Red,Green', server), /Allowed values: Red, Blue/);
});

test('fields resolve by ID or display name, case-insensitively', () => {
	const fields = [{ id: 'customfield_15300', name: 'Account' }, { id: 'summary', name: 'Summary' }, { id: 'customfield_9', name: 'Twin' }, { id: 'customfield_10', name: 'twin' }];
	assert.equal(findField(fields, 'account').id, 'customfield_15300');
	assert.equal(findField(fields, 'customfield_15300').id, 'customfield_15300');
	assert.equal(findField(fields, 'Nope'), undefined);
	assert.throws(() => findField(fields, 'TWIN'), /More than one field is named "TWIN": customfield_9, customfield_10/);
});

test('required fields without a value or default are reported', () => {
	const meta = metaList({
		summary: { name: 'Summary', required: true },
		project: { name: 'Project', required: true },
		customfield_15300: { name: 'Account', required: true },
		priority: { name: 'Priority', required: true, hasDefaultValue: true },
		labels: { name: 'Labels', required: false },
	});
	assert.deepEqual(missingRequired(meta, { summary: 'x', project: { key: 'P' } }).map((f) => f.id), ['customfield_15300']);
});

test('field values have a short readable form', () => {
	assert.equal(readable({ id: 23533, key: 'ACC-1', name: 'Internal' }), 'Internal (ACC-1)');
	assert.equal(readable({ displayName: 'Ann', name: 'ann' }), 'Ann');
	assert.equal(readable({ value: 'Parent', child: { value: 'Child' } }), 'Parent / Child');
	assert.equal(readable([{ name: '1.0' }, { name: '1.1' }]), '1.0, 1.1');
	assert.equal(readable({ originalEstimate: '1d', remainingEstimate: '4h', timeSpent: '4h' }), 'original 1d, remaining 4h, spent 4h');
	assert.equal(readable([]), null);
	assert.equal(readable(3), '3');
});

test('--fields and --all-fields resolve names from the issue', () => {
	const issue = {
		names: { summary: 'Summary', customfield_15300: 'Account', customfield_1: 'Empty' },
		fields: { summary: 'S', customfield_15300: { id: 23533, key: 'ACC', name: 'Internal' }, customfield_1: null },
	};
	assert.deepEqual(requestedFields(issue, { fields: 'account' }), [
		{ id: 'customfield_15300', name: 'Account', value: 'Internal (ACC)', raw: { id: 23533, key: 'ACC', name: 'Internal' } },
	]);
	assert.deepEqual(requestedFields(issue, { allFields: true }).map((f) => f.id), ['summary', 'customfield_15300']);
	assert.throws(() => requestedFields(issue, { fields: 'Nope' }), /Unknown field "Nope"/);
	assert.equal(requestedFields(issue, {}), null);
});

test('paged metadata is collected across pages', async () => {
	const all = Array.from({ length: 5 }, (_, i) => i);
	const starts = [];
	const items = await collectPages(async (startAt) => {
		starts.push(startAt);
		return { startAt, maxResults: 2, total: 5, values: all.slice(startAt, startAt + 2) };
	}, (d) => d.values);
	assert.deepEqual(items, all);
	assert.deepEqual(starts, [0, 2, 4]);
});

// --- create metadata endpoints per Jira version ---

let site;
let routes;
let paths;

before(async () => {
	site = createServer((req, res) => {
		paths.push(req.url);
		const path = req.url.split('?')[0];
		const data = routes[path];
		res.writeHead(data ? 200 : 404, { 'content-type': 'application/json' });
		res.end(JSON.stringify(data ?? { errorMessages: ['not found'] }));
	});
	await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
});

after(() => site.close());

const accountField = { required: true, name: 'Account', schema: schemas.account.schema };

test('Jira 9+ reads create metadata from the paged per-type endpoints', async () => {
	paths = [];
	routes = {
		'/rest/api/2/serverInfo': { version: '9.12.0', versionNumbers: [9, 12, 0] },
		'/rest/api/2/issue/createmeta/PROJ/issuetypes': { startAt: 0, maxResults: 50, total: 2, values: [{ id: '1', name: 'Bug' }, { id: '3', name: 'Task' }] },
		'/rest/api/2/issue/createmeta/PROJ/issuetypes/3': { startAt: 0, maxResults: 50, total: 1, values: [{ fieldId: 'customfield_15300', ...accountField }] },
	};
	const connection = { type: 'jira', baseUrl: `http://127.0.0.1:${site.address().port}`, token: 't' };
	const meta = await serverCreateMeta(connection, 'PROJ', { name: 'task' });
	assert.equal(meta.issueType.id, '3');
	assert.deepEqual(metaList(meta.fields).map((f) => [f.id, f.required]), [['customfield_15300', true]]);
	assert.deepEqual(paths.map((p) => p.split('?')[0]), Object.keys(routes));
	await assert.rejects(serverCreateMeta(connection, 'PROJ', { name: 'Epic' }), /Issue type "Epic" is not available in project PROJ. Available: Bug, Task/);
});

test('Jira before 9 reads create metadata from the expand form', async () => {
	paths = [];
	routes = {
		'/rest/api/2/serverInfo': { version: '8.20.10', versionNumbers: [8, 20, 10] },
		'/rest/api/2/issue/createmeta': { projects: [{ key: 'OLD', issuetypes: [{ id: '3', name: 'Task', fields: { customfield_15300: accountField } }] }] },
	};
	// Another base URL, because the server version is cached per site.
	const connection = { type: 'jira', baseUrl: `http://localhost:${site.address().port}`, token: 't' };
	const meta = await serverCreateMeta(connection, 'OLD', { name: 'Task' });
	assert.deepEqual(metaList(meta.fields).map((f) => f.id), ['customfield_15300']);
	const query = new URLSearchParams(paths[1].split('?')[1]);
	assert.equal(query.get('projectKeys'), 'OLD');
	assert.equal(query.get('expand'), 'projects.issuetypes.fields');
});

test('Jira Cloud reads create metadata from its paged endpoints', async (t) => {
	const urls = [];
	t.mock.method(globalThis, 'fetch', async (url) => {
		urls.push(url.pathname);
		if (url.pathname.endsWith('/issuetypes')) return Response.json({ startAt: 0, maxResults: 50, total: 1, issueTypes: [{ id: '10001', name: 'Task' }] });
		return Response.json({ startAt: 0, maxResults: 50, total: 1, fields: [{ fieldId: 'customfield_10050', key: 'customfield_10050', name: 'Team', required: true, schema: { type: 'string' } }] });
	});
	const connection = { type: 'serviceDesk', baseUrl: 'https://example.atlassian.net', email: 'e', token: 't' };
	const meta = await cloudCreateMeta(connection, 'TUKI', { id: '10001' });
	assert.deepEqual(metaList(meta.fields).map((f) => f.id), ['customfield_10050']);
	assert.deepEqual(urls, ['/rest/api/3/issue/createmeta/TUKI/issuetypes', '/rest/api/3/issue/createmeta/TUKI/issuetypes/10001']);
});
