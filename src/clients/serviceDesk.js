import { addServiceDeskComment } from './jiraCloud.js';

// A `serviceDesk` connection is a Jira Cloud site; it uses the Jira Cloud client, except that new
// comments go through the Service Desk API, internal unless public, as they always have.
export * from './jiraCloud.js';

export async function addComment(connection, issueKey, body, { isPublic = false } = {}) {
	return addServiceDeskComment(connection, issueKey, body, isPublic);
}
