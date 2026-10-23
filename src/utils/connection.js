import { getConnection } from '../config/store.js';

export function connectionFor(cmd, type) {
	return getConnection(type, cmd.optsWithGlobals().connection);
}
