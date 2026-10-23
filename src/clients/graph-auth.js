import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { configPath, validateGraphId } from '../config/store.js';
import { createProtectedCache } from './graph-cache.js';

export const GRAPH_SCOPES = ['User.Read', 'Chat.Read', 'Mail.Read', 'Sites.Read.All'];
export const SHARED_MAIL_SCOPE = 'Mail.Read.Shared';
export const CALENDAR_SCOPE = 'Calendars.Read.Shared';
export const AVAILABILITY_SCOPE = 'Calendars.ReadBasic';

function requestedScopes({ sharedMail = false, calendars = false, availability = false, all = false } = {}) {
	return [...GRAPH_SCOPES,
		...(sharedMail || all ? [SHARED_MAIL_SCOPE] : []),
		...(calendars || all ? [CALENDAR_SCOPE, AVAILABILITY_SCOPE] : availability ? [AVAILABILITY_SCOPE] : []),
	];
}

export function graphIdentity(connection = {}) {
	const tenantId = connection.tenantId?.trim().toLowerCase();
	const clientId = connection.clientId?.trim().toLowerCase();
	if (validateGraphId(tenantId) || validateGraphId(clientId)) {
		throw new Error('The Microsoft Graph connection needs a valid tenant ID and client ID. Run: dev graph setup');
	}
	return { tenantId, clientId };
}

// The token cache is partitioned by tenant and client ID, so connections for the same application share one sign-in.
async function createApplication(connection) {
	const { tenantId, clientId } = graphIdentity(connection);
	const { PublicClientApplication } = await import('@azure/msal-node');
	const identity = createHash('sha256').update(`${tenantId}:${clientId}`).digest('hex');
	const directory = join(dirname(configPath()), 'graph-auth');
	await mkdir(directory, { recursive: true, mode: 0o700 });
	// Caches written by the earlier msal-node-extensions storage cannot be read by this one.
	await rm(join(directory, `${identity}.bin`), { force: true });
	await rm(join(directory, `${identity}.bin.lockfile`), { force: true });
	return new PublicClientApplication({
		auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` },
		cache: { cachePlugin: createProtectedCache({ path: join(directory, `${identity}.cache`), identity }) },
	});
}

export function createGraphAuth({ connection, applicationFactory = () => createApplication(connection), browserOpener } = {}) {
	let application;
	const app = () => application ||= applicationFactory();

	async function account() {
		const accounts = await (await app()).getTokenCache().getAllAccounts();
		if (accounts.length !== 1) throw new Error('Sign in to Microsoft Graph first. Run: dev graph login');
		return accounts[0];
	}

	return {
		async login(options = {}) {
			const client = await app();
			const openBrowser = browserOpener || (async (url) => {
				const { default: open } = await import('open');
				await open(url);
			});
			const scopes = requestedScopes(options);
			const result = await client.acquireTokenInteractive({
				scopes,
				prompt: 'select_account',
				openBrowser,
				successTemplate: 'Return to the terminal to check the sign-in result. You can close this window.',
				errorTemplate: 'Sign-in failed. Return to the terminal for details.',
			});
			if (!result?.account) throw new Error('Microsoft did not return an account. Run: dev graph login');
			const cache = client.getTokenCache();
			// A cache belongs to one CLI identity so silent requests never pick an arbitrary account.
			for (const cached of await cache.getAllAccounts()) {
				if (cached.homeAccountId !== result.account.homeAccountId) await cache.removeAccount(cached);
			}
			return { username: result.account.username, name: result.account.name || null, tenantId: result.account.tenantId };
		},

		async token({ sharedMail = false, calendars = false, availability = false } = {}) {
			const client = await app();
			const current = await account();
			const scopes = requestedScopes({ sharedMail, calendars, availability });
			try {
				const result = await client.acquireTokenSilent({
					account: current,
					scopes,
				});
				if (!result?.accessToken) throw new Error('No access token returned.');
				return result.accessToken;
			} catch (err) {
				if (['interaction_required', 'consent_required', 'login_required', 'invalid_grant', 'no_tokens_found'].includes(err.errorCode)
					|| err.name === 'InteractionRequiredAuthError') {
					const flags = `${sharedMail ? ' --shared-mail' : ''}${calendars || availability ? ' --calendars' : ''}`;
					throw new Error(`Microsoft sign-in expired or needs consent for ${scopes.join(', ')}. Check delegated permissions, then run: dev graph login${flags}`);
				}
				throw err;
			}
		},

		async status() {
			const current = await account();
			return { username: current.username, name: current.name || null, tenantId: current.tenantId, cached: true };
		},

		async logout() {
			const cache = (await app()).getTokenCache();
			for (const cached of await cache.getAllAccounts()) await cache.removeAccount(cached);
			return { signedOut: true, message: 'Local Graph account removed. Browser sessions and server-side grants are unchanged.' };
		},
	};
}
