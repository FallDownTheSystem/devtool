import { apiErrorDetail } from './errors.js';

const DEFAULT_TIMEOUT_SECONDS = 30;

// Every API request gives up after DEV_TIMEOUT seconds (default 30), so a stalled server fails with a
// clear message instead of hanging the command.
function requestTimeout() {
	const seconds = Number(process.env.DEV_TIMEOUT);
	return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS) * 1000;
}

export function timeoutSignal() {
	return AbortSignal.timeout(requestTimeout());
}

// Fetch options for a JSON API call; a body is sent as JSON.
export function jsonInit({ method = 'GET', headers = {}, body } = {}) {
	return {
		method,
		headers: {
			'Accept': 'application/json',
			...headers,
			...(body !== undefined && { 'Content-Type': 'application/json' }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: timeoutSignal(),
	};
}

// The error for a non-2xx response, with the API's own messages in `detail`.
export async function apiError(service, res, url) {
	const err = new Error(`${service} API error: ${res.status} ${res.statusText}`);
	err.status = res.status;
	err.url = url.toString();
	err.detail = apiErrorDetail(await res.json().catch(() => null));
	return err;
}
