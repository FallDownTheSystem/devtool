import { timeoutSignal } from './http.js';

const deployments = new Map();

// Custom domains hide the atlassian.net hostname, so anything else is probed:
// Atlassian's edge answers tenant_info anonymously, Server/Data Center does not.
async function detect(origin) {
	if (/\.atlassian\.net$/i.test(new URL(origin).hostname)) return 'cloud';
	try {
		const res = await fetch(new URL('/_edge/tenant_info', origin), {
			headers: { 'Accept': 'application/json' },
			signal: timeoutSignal(),
		});
		if (res.ok && (await res.json()).cloudId) return 'cloud';
	} catch {
		// An unreachable or non-JSON probe means no Atlassian edge; the real request reports connection errors.
	}
	return 'server';
}

// 'cloud' or 'server' (Server/Data Center) for an Atlassian site, detected once per origin.
export function deploymentOf(origin) {
	if (!deployments.has(origin)) deployments.set(origin, detect(origin));
	return deployments.get(origin);
}
