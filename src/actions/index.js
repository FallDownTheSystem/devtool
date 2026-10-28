import * as bitbucket from './bitbucket.js';
import * as confluence from './confluence.js';
import * as jira from './jira.js';

const all = [bitbucket, confluence, jira].flatMap((group) => Object.values(group)).filter((action) => action?.run);

// Pending actions store an action name; approving one looks the action up here. Versions before 0.9
// held Service Desk writes as sd.*; those names map to the merged Jira actions.
export const actions = Object.fromEntries([
	...all.map((action) => [action.name, action]),
	...all.filter((action) => action.name.startsWith('jira.')).map((action) => [`sd.${action.name.slice('jira.'.length)}`, action]),
]);
