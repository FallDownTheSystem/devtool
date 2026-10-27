import { error } from './output.js';

// Collects the messages from the error bodies of Atlassian APIs: Jira (errorMessages and errors),
// Confluence Cloud v2 (errors[].title/detail), Confluence Server and Bitbucket (message or error.message).
export function apiErrorDetail(data) {
	if (!data || typeof data !== 'object') return typeof data === 'string' && data.trim() ? data.trim().slice(0, 500) : undefined;
	const messages = [];
	if (Array.isArray(data.errorMessages)) messages.push(...data.errorMessages);
	if (data.errors && typeof data.errors === 'object' && !Array.isArray(data.errors)) {
		messages.push(...Object.entries(data.errors).map(([key, value]) => `${key}: ${value}`));
	}
	if (Array.isArray(data.errors)) messages.push(...data.errors.map((e) => [e.title, e.detail].filter(Boolean).join(': ')));
	if (data.error?.message) messages.push(data.error.message);
	if (data.error?.detail) messages.push(data.error.detail);
	if (typeof data.message === 'string' && !messages.length) messages.push(data.message);
	const text = messages.filter(Boolean).join('\n');
	return text || undefined;
}

// Bitbucket and Confluence clients set `detail`; jira.js keeps the response body on the error.
function detailOf(err) {
	return err.detail ?? apiErrorDetail(err.response?.data);
}

export function handleError(err, context = '') {
	const status = err.status ?? err.statusCode;
	const detail = detailOf(err);

	const report = (message) => {
		error(message);
		if (detail) error(detail);
		if (context) error(`Endpoint: ${context}`);
		process.exitCode = 1;
	};

	if (status === 401) {
		const service = context.includes('bitbucket') ? 'Bitbucket' : context.includes('jira') ? 'Jira' : context.includes('confluence') ? 'Confluence' : '';
		report(`Authentication failed${service ? ` for ${service}` : ''}. Check your API token.`);
		return;
	}

	if (status === 403) {
		report('Access denied. Your token may lack the required scopes or permissions.');
		return;
	}

	if (status === 404) {
		report('Not found. Check that the resource exists and you have access.');
		return;
	}

	if (status === 409) {
		report('Conflict. The resource changed after it was read; read it again and retry.');
		return;
	}

	if (status === 400) {
		report('The request was rejected as invalid.');
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
	if (detail) error(detail);
	if (context) error(`Context: ${context}`);
	process.exitCode = 1;
}
