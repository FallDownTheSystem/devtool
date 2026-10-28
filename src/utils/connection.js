import { getConnection } from '../config/store.js';

// `type` is a connection type or a list of them; `project` (a project or issue key) routes to the
// connection that lists the project when no --connection is given.
export function connectionFor(cmd, type, project) {
	return getConnection(type, cmd.optsWithGlobals().connection, projectOf(project));
}

export function projectOf(keyOrProject) {
	if (!keyOrProject) return undefined;
	const match = /^([A-Za-z][A-Za-z0-9_]*)(?:-\d+)?$/.exec(String(keyOrProject).trim());
	return match ? match[1] : undefined;
}
