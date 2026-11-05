import { site } from './jira.js';
import * as server from './tempoServer.js';
import * as cloud from './tempoCloud.js';

// The Tempo client of a Jira connection's site: the Timesheets plugin API on Server/Data Center, or
// api.tempo.io with its own token on Cloud. Both read and write worklogs in one shape (see tempoServer.js).
export async function tempo(connection) {
	const s = await site(connection);
	return { cloud: s.cloud, client: s.cloud ? cloud : server };
}
