import { apiErrorDetail } from './errors.js';

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
