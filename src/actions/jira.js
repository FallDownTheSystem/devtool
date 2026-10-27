import * as client from '../clients/jira.js';
import { issueActions } from './issues.js';

// Jira Server takes wiki markup as plain strings and identifies users by user name.
export const dialect = {
	prefix: 'jira',
	type: 'jira',
	client,
	text: (value) => value,
	user: (name) => ({ name }),
};

export default issueActions(dialect);
