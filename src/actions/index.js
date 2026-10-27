import * as bitbucket from './bitbucket.js';
import * as confluence from './confluence.js';
import jira from './jira.js';
import serviceDesk from './serviceDesk.js';

// Pending actions store an action name; approving one looks the action up here.
export const actions = Object.fromEntries(
	[bitbucket, confluence, jira, serviceDesk]
		.flatMap((group) => Object.values(group))
		.map((action) => [action.name, action]),
);
