import * as server from './jiraServer.js';
import * as cloud from './jiraCloud.js';
import * as serviceDesk from './serviceDesk.js';
import { textToAdf } from '../utils/markup.js';
import { timeoutSignal } from '../utils/http.js';

// `dev jira` works with both connection types: `jira` (Cloud or Server/Data Center) and `serviceDesk`
// (always Cloud). The site decides the client and the format of rich text and user references.
export const JIRA_TYPES = ['jira', 'serviceDesk'];

const deployments = new Map();

// serverInfo answers anonymously on both deployments and names the deployment type.
async function probe(baseUrl) {
	try {
		const res = await fetch(new URL(`${baseUrl.replace(/\/+$/, '')}/rest/api/2/serverInfo`), {
			headers: { 'Accept': 'application/json' },
			redirect: 'manual',
			signal: timeoutSignal(),
		});
		if (res.ok && (await res.json()).deploymentType === 'Cloud') return 'cloud';
	} catch {
		// An unreachable or non-JSON answer: the real request reports the problem.
	}
	return 'server';
}

// 'cloud' or 'server'. A connection's `deployment` setting wins. Jira Cloud authenticates with an
// email and API token, so a connection without an email is Server/Data Center and needs no probe.
export async function deployment(connection) {
	if (connection.type === 'serviceDesk') return 'cloud';
	if (connection.deployment) return connection.deployment;
	if (/\.atlassian\.net$/i.test(new URL(connection.baseUrl).hostname)) return 'cloud';
	if (!connection.email) return 'server';
	if (!deployments.has(connection.baseUrl)) deployments.set(connection.baseUrl, probe(connection.baseUrl));
	return deployments.get(connection.baseUrl);
}

const SERVER = { cloud: false, client: server, text: (value) => value, user: (name) => ({ name }) };
const CLOUD = { cloud: true, client: cloud, text: textToAdf, user: (accountId) => ({ accountId }) };

// The client and value formats of a connection's site:
//   cloud    whether the site is Jira Cloud (ADF, account IDs, token-paged search, public replies)
//   client   jiraServer.js or jiraCloud.js (serviceDesk.js for serviceDesk connections)
//   text     maps plain text to the API's rich-text value
//   user     maps a user reference (user name or account ID) to the API's user value
export async function site(connection) {
	if (await deployment(connection) === 'server') return SERVER;
	if (!connection.email) throw new Error('Jira Cloud signs in with your account email and an API token. Set the email of this connection with `dev config edit <connection>`.');
	return connection.type === 'serviceDesk' ? { ...CLOUD, client: serviceDesk } : CLOUD;
}
