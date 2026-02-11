export function getOutputMode(cmd) {
	const globals = cmd.optsWithGlobals ? cmd.optsWithGlobals() : cmd.opts();
	if (globals.json) return 'json';
	if (globals.plain) return 'plain';
	return 'rich';
}

export function outputJson(data) {
	console.log(JSON.stringify(data, null, 2));
}
