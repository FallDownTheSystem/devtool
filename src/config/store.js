import { dirname } from 'node:path';
import Conf from 'conf';

export function validateGraphId(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value?.trim() || '')
		? undefined
		: 'Enter the ID as a UUID from the Entra application Overview page.';
}

export function validateGraphSite(value) {
	if (!value?.trim()) return undefined;
	try {
		const url = new URL(value.trim());
		if (url.protocol === 'https:' && url.hostname.endsWith('.sharepoint.com') && !url.username && !url.password && !url.port && !url.search && !url.hash) {
			decodeURIComponent(url.pathname);
			return undefined;
		}
	} catch {}
	return 'Enter a SharePoint Online site URL without a query or fragment.';
}

// A field's `validate` returns a problem message for a non-empty value; `normalize` runs on every save.
// A type with a `writeTarget` has write commands, gated per connection by `settings`; the field it names
// identifies the site that writes go to.
export const types = {
	bitbucket: {
		title: 'Bitbucket',
		writeTarget: 'workspace',
		fields: {
			workspace: { title: 'Workspace', message: 'Bitbucket workspace slug', placeholder: 'my-workspace', required: true },
			defaultRepo: { title: 'Default repo', message: 'Bitbucket default repo slug', placeholder: 'my-repo' },
			email: { title: 'Email', message: 'Bitbucket account email', placeholder: 'you@company.com', required: true },
			token: { title: 'Token', message: 'Bitbucket API token', secret: true, required: true },
		},
	},
	jira: {
		title: 'Jira',
		writeTarget: 'baseUrl',
		fields: {
			baseUrl: { title: 'Base URL', message: 'Jira Server base URL', placeholder: 'https://jira.company.com', required: true },
			token: { title: 'Token', message: 'Jira Personal Access Token', secret: true, required: true },
			defaultProject: { title: 'Default project', message: 'Jira default project key', placeholder: 'PROJ' },
		},
	},
	confluence: {
		title: 'Confluence',
		writeTarget: 'baseUrl',
		fields: {
			baseUrl: { title: 'Base URL', message: 'Confluence base URL (Cloud or Server/Data Center)', placeholder: 'https://company.atlassian.net', required: true },
			email: { title: 'Email', message: 'Confluence account email (Server/Data Center: username, or empty for a personal access token)', placeholder: 'you@company.com' },
			token: { title: 'Token', message: 'Confluence API token (Server/Data Center: personal access token or password)', secret: true, required: true },
			defaultSpace: { title: 'Default space', message: 'Confluence default space key', placeholder: 'DEV' },
		},
	},
	serviceDesk: {
		title: 'Service Desk',
		writeTarget: 'baseUrl',
		fields: {
			baseUrl: { title: 'Base URL', message: 'Jira Service Desk Cloud base URL (use canonical *.atlassian.net, not a vanity domain)', placeholder: 'https://company.atlassian.net', required: true },
			email: { title: 'Email', message: 'Service Desk account email', placeholder: 'you@company.com', required: true },
			token: { title: 'Token', message: 'Service Desk API token', secret: true, required: true },
			defaultProject: { title: 'Default project', message: 'Service Desk default project key', placeholder: 'TUKI' },
		},
	},
	graph: {
		title: 'Microsoft Graph',
		note: 'Teams, email, calendars, and SharePoint share this application. No client secret is needed.\nRegister http://localhost under Mobile and desktop applications.\nDelegated permissions: User.Read, Chat.Read, Mail.Read, Sites.Read.All.\nOptional: Calendars.Read.Shared and Calendars.ReadBasic for calendars/free-busy; Mail.Read.Shared for shared email.\nAfter saving, run dev graph login (--all for one sign-in with every supported permission).',
		fields: {
			tenantId: { title: 'Tenant ID', message: 'Directory (tenant) ID', required: true, validate: validateGraphId, normalize: (v) => v.trim().toLowerCase() },
			clientId: { title: 'Client ID', message: 'Application (client) ID', required: true, validate: validateGraphId, normalize: (v) => v.trim().toLowerCase() },
			defaultSite: { title: 'Default site', message: 'Default SharePoint site URL (optional)', placeholder: 'https://company.sharepoint.com/sites/MySite', validate: validateGraphSite, normalize: (v) => v.trim().replace(/\/+$/, '') },
		},
	},
};

export function fieldProblem(type, key, value) {
	const field = types[type].fields[key];
	return value && field.validate ? field.validate(value) : undefined;
}

// Boolean settings of writable connections. Writes stay off until enabled, and an enabled write
// waits for approval unless approval is turned off.
export const settings = {
	allowWrite: { title: 'Allow write', message: 'Allow commands that create, change, or delete data?', default: false },
	requireApproval: { title: 'Require approval', message: 'Hold each write until it is approved with `dev pending approve`?', default: true },
};

export function settingKeys(type) {
	return types[type].writeTarget ? Object.keys(settings) : [];
}

export function setting(connection, key) {
	return typeof connection[key] === 'boolean' ? connection[key] : settings[key].default;
}

function parseBoolean(value) {
	const normalized = String(value).trim().toLowerCase();
	if (['true', 'yes', 'on', '1'].includes(normalized)) return true;
	if (['false', 'no', 'off', '0'].includes(normalized)) return false;
	throw new Error(`Invalid value "${value}". Use true or false.`);
}

const config = new Conf({
	projectName: 'devtool',
	schema: {
		connections: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					type: { type: 'string', enum: Object.keys(types) },
					name: { type: 'string' },
					default: { type: 'boolean' },
					...Object.fromEntries(Object.keys(settings).map((key) => [key, { type: 'boolean' }])),
				},
				required: ['type'],
				additionalProperties: { type: 'string' },
			},
		},
	},
	defaults: { connections: [] },
});

migrateLegacySections();

// Older versions stored exactly one connection per type as a top-level section.
function migrateLegacySections() {
	const { connections = [], ...rest } = config.store;
	const legacy = Object.keys(rest).filter((key) => types[key]);
	if (!legacy.length) return;
	for (const type of legacy) {
		const connection = clean({ type, ...rest[type] });
		const hasValues = Object.keys(connection).length > 1;
		if (hasValues && !connections.some((c) => c.type === type && !c.name)) connections.push(connection);
		delete rest[type];
	}
	config.store = { ...rest, connections };
}

function clean(connection) {
	const result = { type: connection.type };
	if (connection.name) result.name = connection.name;
	if (connection.default) result.default = true;
	for (const [key, field] of Object.entries(types[connection.type].fields)) {
		if (typeof connection[key] !== 'string') continue;
		const value = field.normalize ? field.normalize(connection[key]) : connection[key];
		if (value !== '') result[key] = value;
	}
	for (const key of settingKeys(connection.type)) {
		if (typeof connection[key] === 'boolean') result[key] = connection[key];
	}
	return result;
}

function write(connections) {
	config.set('connections', connections.map(clean));
}

// An unnamed connection is addressed by its type, so labels stay unique across all connections.
export function label(connection) {
	return connection.name || connection.type;
}

export function listConnections() {
	return config.get('connections');
}

function defaultIndex(connections, type) {
	const flagged = connections.findIndex((c) => c.type === type && c.default);
	return flagged !== -1 ? flagged : connections.findIndex((c) => c.type === type);
}

export function isDefault(connections, index) {
	return defaultIndex(connections, connections[index].type) === index;
}

// A reference is a connection label; a bare type falls back to that type's default connection.
function findIndex(connections, ref) {
	const byLabel = connections.findIndex((c) => label(c) === ref);
	if (byLabel !== -1 || !types[ref]) return byLabel;
	return defaultIndex(connections, ref);
}

function requireIndex(connections, ref) {
	const index = findIndex(connections, ref);
	if (index === -1) throw new Error(`No connection named "${ref}". Run \`dev config show\` to list connections.`);
	return index;
}

export function getConnection(type, ref) {
	const connections = listConnections();
	const { title } = types[type];
	if (ref) {
		const connection = connections[requireIndex(connections, ref)];
		if (connection.type !== type) {
			throw new Error(`Connection "${ref}" is a ${types[connection.type].title} connection, not ${title}.`);
		}
		return connection;
	}
	const index = defaultIndex(connections, type);
	if (index === -1) throw new Error(`No ${title} connection configured. Run \`dev config add ${type}\` to add one.`);
	return connections[index];
}

export function resolveIndex(ref) {
	return requireIndex(listConnections(), ref);
}

export function validateName(connections, connection, index = -1) {
	const { name, type } = connection;
	if (name) {
		if (!/^[A-Za-z0-9][\w-]*$/.test(name)) {
			return 'Use only letters, digits, "-" and "_", starting with a letter or digit';
		}
		if (Object.keys(types).some((t) => t.toLowerCase() === name.toLowerCase())) {
			return `"${name}" is a connection type and cannot be a name`;
		}
	}
	const clash = connections.some((c, i) => i !== index && label(c) === label(connection));
	if (clash) {
		return name
			? `A connection named "${name}" already exists`
			: `A ${types[type].title} connection without a name already exists; give this one a name`;
	}
	return undefined;
}

// Without an index the connection is appended.
export function saveConnection(connection, index = -1) {
	const connections = listConnections();
	const problem = validateName(connections, connection, index);
	if (problem) throw new Error(problem);
	if (index === -1) connections.push(connection);
	else connections[index] = connection;
	write(connections);
}

export function removeConnection(ref) {
	const connections = listConnections();
	const [removed] = connections.splice(requireIndex(connections, ref), 1);
	write(connections);
	return removed;
}

export function setDefault(ref) {
	const connections = listConnections();
	const target = connections[requireIndex(connections, ref)];
	for (const c of connections) {
		if (c.type === target.type) c.default = c === target;
	}
	write(connections);
	return target;
}

// A bare type with no connection yet creates one, so `config set jira.baseUrl ...` works on a fresh install.
export function setField(ref, field, value) {
	const connections = listConnections();
	let index = findIndex(connections, ref);
	if (index === -1) {
		if (!types[ref]) throw new Error(`No connection named "${ref}". Run \`dev config show\` to list connections.`);
		connections.push({ type: ref });
		index = connections.length - 1;
	}
	const connection = connections[index];
	const fields = Object.keys(types[connection.type].fields);
	const booleans = settingKeys(connection.type);
	if (field !== 'name' && !fields.includes(field) && !booleans.includes(field)) {
		throw new Error(`Invalid field "${field}" for a ${types[connection.type].title} connection. Valid fields: ${['name', ...fields, ...booleans].join(', ')}`);
	}
	connection[field] = booleans.includes(field) ? parseBoolean(value) : value;
	let problem;
	if (field === 'name') problem = validateName(connections, connection, index);
	else if (fields.includes(field)) problem = fieldProblem(connection.type, field, value);
	if (problem) throw new Error(problem);
	write(connections);
	return connection;
}

export function configPath() {
	return config.path;
}

export function configDirectory() {
	return dirname(config.path);
}

export default config;
