import { error } from './output.js';

export function handleError(err, context = '') {
	if (err.status === 401 || err.statusCode === 401) {
		const service = context.includes('bitbucket') ? 'Bitbucket' : context.includes('jira') ? 'Jira' : '';
		error(`Authentication failed${service ? ` for ${service}` : ''}. Check your API token.`);
		if (context) error(`Endpoint: ${context}`);
		process.exitCode = 1;
		return;
	}

	if (err.status === 403 || err.statusCode === 403) {
		error('Access denied. Your token may lack the required scopes.');
		if (context) error(`Endpoint: ${context}`);
		process.exitCode = 1;
		return;
	}

	if (err.status === 404 || err.statusCode === 404) {
		error('Not found. Check that the resource exists and you have access.');
		if (context) error(`Endpoint: ${context}`);
		process.exitCode = 1;
		return;
	}

	if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
		error(`Could not connect to server.`);
		if (context) error(`URL: ${context}`);
		error('Check that the URL is correct and the server is reachable.');
		process.exitCode = 1;
		return;
	}

	if (err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || err.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
		error('SSL certificate error. If using a self-signed cert, set NODE_TLS_REJECT_UNAUTHORIZED=0');
		process.exitCode = 1;
		return;
	}

	error(err.message || String(err));
	if (context) error(`Context: ${context}`);
	process.exitCode = 1;
}
