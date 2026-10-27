import * as client from '../clients/serviceDesk.js';
import { textToAdf } from '../utils/markup.js';
import { issueActions } from './issues.js';

// Jira Cloud takes rich text as ADF and identifies users by account ID.
export const dialect = {
	prefix: 'sd',
	type: 'serviceDesk',
	client,
	text: textToAdf,
	user: (accountId) => ({ accountId }),
	publicComments: true,
};

export default issueActions(dialect);
