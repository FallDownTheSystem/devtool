import Conf from 'conf';
import * as p from '@clack/prompts';
import pc from 'picocolors';

const schema = {
	bitbucket: {
		type: 'object',
		properties: {
			workspace: { type: 'string' },
			defaultRepo: { type: 'string' },
			email: { type: 'string' },
			token: { type: 'string' },
		},
	},
	jira: {
		type: 'object',
		properties: {
			baseUrl: { type: 'string' },
			token: { type: 'string' },
			defaultProject: { type: 'string' },
		},
	},
	confluence: {
		type: 'object',
		properties: {
			baseUrl: { type: 'string' },
			email: { type: 'string' },
			token: { type: 'string' },
			defaultSpace: { type: 'string' },
		},
	},
	graph: {
		type: 'object',
		properties: {
			tenantId: { type: 'string' },
			clientId: { type: 'string' },
			defaultSite: { type: 'string' },
		},
	},
	serviceDesk: {
		type: 'object',
		properties: {
			baseUrl: { type: 'string' },
			email: { type: 'string' },
			token: { type: 'string' },
			defaultProject: { type: 'string' },
		},
	},
};

const config = new Conf({
	projectName: 'devtool',
	schema,
	defaults: {
		bitbucket: { workspace: '', defaultRepo: '', email: '', token: '' },
		jira: { baseUrl: '', token: '', defaultProject: '' },
		confluence: { baseUrl: '', email: '', token: '', defaultSpace: '' },
		serviceDesk: { baseUrl: '', email: '', token: '', defaultProject: '' },
		graph: { tenantId: '', clientId: '', defaultSite: '' },
	},
});

export function get(key) {
	return config.get(key);
}

export function set(key, value) {
	config.set(key, value);
}

export function getAll() {
	return config.store;
}

export function isConfigured() {
	const bb = config.get('bitbucket');
	const jira = config.get('jira');
	return !!(bb.workspace && bb.token && jira.baseUrl && jira.token);
}

export function configPath() {
	return config.path;
}

export function validateGraphId(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value?.trim() || '')
		? undefined
		: 'Enter the ID as a UUID from the Entra application Overview page.';
}

export function validateGraphSite(value) {
	if (!value?.trim()) return undefined;
	try {
		const url = new URL(value.trim());
		if (url.protocol === 'https:' && url.hostname.endsWith('.sharepoint.com') && !url.username && !url.password && !url.port && !url.search && !url.hash) {
			decodeURIComponent(url.pathname);
			return undefined;
		}
	} catch {}
	return 'Enter a SharePoint Online site URL without a query or fragment.';
}

export async function runGraphSetup() {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error('Graph setup requires a terminal. Use dev config set graph.tenantId <id> and dev config set graph.clientId <id> instead.');
	}
	p.intro(pc.cyan('Microsoft Graph Setup'));
	p.note('Teams, email, calendars, and SharePoint share this application. No client secret is needed.\nRegister http://localhost under Mobile and desktop applications.\nDelegated permissions: User.Read, Chat.Read, Mail.Read, Sites.Read.All.\nOptional: Calendars.Read.Shared and Calendars.ReadBasic for calendars/free-busy; Mail.Read.Shared for shared email.\nUse dev graph login --all for one sign-in with every supported permission.', 'Entra application');
	const graph = await p.group({
		tenantId: () => p.text({
			message: 'Directory (tenant) ID',
			initialValue: config.get('graph.tenantId') || '',
			validate: validateGraphId,
		}),
		clientId: () => p.text({
			message: 'Application (client) ID',
			initialValue: config.get('graph.clientId') || '',
			validate: validateGraphId,
		}),
		defaultSite: () => p.text({
			message: 'Default SharePoint site URL (optional)',
			placeholder: 'https://company.sharepoint.com/sites/MySite',
			initialValue: config.get('graph.defaultSite') || '',
			validate: validateGraphSite,
		}),
	}, {
		onCancel: () => {
			p.cancel('Setup cancelled.');
			process.exit(0);
		},
	});
	config.set('graph', {
		tenantId: graph.tenantId.trim().toLowerCase(),
		clientId: graph.clientId.trim().toLowerCase(),
		defaultSite: graph.defaultSite.trim().replace(/\/+$/, ''),
	});
	p.outro(pc.green('Graph configuration saved. Run: dev graph login'));
}

export async function runSetup() {
	p.intro(pc.cyan('DevTool Setup'));

	const bb = await p.group({
		workspace: () => p.text({
			message: 'Bitbucket workspace slug',
			placeholder: 'my-workspace',
			initialValue: config.get('bitbucket.workspace') || '',
			validate: (v) => !v ? 'Required' : undefined,
		}),
		defaultRepo: () => p.text({
			message: 'Bitbucket default repo slug',
			placeholder: 'my-repo',
			initialValue: config.get('bitbucket.defaultRepo') || '',
			validate: (v) => !v ? 'Required' : undefined,
		}),
		email: () => p.text({
			message: 'Bitbucket account email',
			placeholder: 'you@company.com',
			initialValue: config.get('bitbucket.email') || '',
			validate: (v) => !v ? 'Required' : undefined,
		}),
		token: () => p.password({
			message: 'Bitbucket API token',
			validate: (v) => !v ? 'Required' : undefined,
		}),
	}, {
		onCancel: () => {
			p.cancel('Setup cancelled.');
			process.exit(0);
		},
	});

	const jira = await p.group({
		baseUrl: () => p.text({
			message: 'Jira Server base URL',
			placeholder: 'https://jira.company.com',
			initialValue: config.get('jira.baseUrl') || '',
			validate: (v) => !v ? 'Required' : undefined,
		}),
		token: () => p.password({
			message: 'Jira Personal Access Token',
			validate: (v) => !v ? 'Required' : undefined,
		}),
		defaultProject: () => p.text({
			message: 'Jira default project key',
			placeholder: 'PROJ',
			initialValue: config.get('jira.defaultProject') || '',
			validate: (v) => !v ? 'Required' : undefined,
		}),
	}, {
		onCancel: () => {
			p.cancel('Setup cancelled.');
			process.exit(0);
		},
	});

	const confluence = await p.group({
		baseUrl: () => p.text({
			message: 'Confluence Cloud base URL',
			placeholder: 'https://company.atlassian.net',
			initialValue: config.get('confluence.baseUrl') || '',
		}),
		email: () => p.text({
			message: 'Confluence account email',
			placeholder: 'you@company.com',
			initialValue: config.get('confluence.email') || '',
		}),
		token: () => p.password({
			message: 'Confluence API token',
		}),
		defaultSpace: () => p.text({
			message: 'Confluence default space key',
			placeholder: 'DEV',
			initialValue: config.get('confluence.defaultSpace') || '',
		}),
	}, {
		onCancel: () => {
			p.cancel('Setup cancelled.');
			process.exit(0);
		},
	});

	const reuseConfluenceCreds = confluence.email && confluence.token
		? await p.confirm({
			message: 'Reuse Confluence email/token for Jira Service Desk Cloud?',
			initialValue: true,
		})
		: false;

	if (p.isCancel(reuseConfluenceCreds)) {
		p.cancel('Setup cancelled.');
		process.exit(0);
	}

	const serviceDesk = await p.group({
		baseUrl: () => p.text({
			message: 'Jira Service Desk Cloud base URL (use canonical *.atlassian.net, not a vanity domain)',
			placeholder: 'https://company.atlassian.net',
			initialValue: config.get('serviceDesk.baseUrl') || '',
		}),
		email: () => reuseConfluenceCreds
			? Promise.resolve(confluence.email)
			: p.text({
				message: 'Service Desk account email',
				placeholder: 'you@company.com',
				initialValue: config.get('serviceDesk.email') || '',
			}),
		token: () => reuseConfluenceCreds
			? Promise.resolve(confluence.token)
			: p.password({
				message: 'Service Desk API token',
			}),
		defaultProject: () => p.text({
			message: 'Service Desk default project key',
			placeholder: 'TUKI',
			initialValue: config.get('serviceDesk.defaultProject') || '',
		}),
	}, {
		onCancel: () => {
			p.cancel('Setup cancelled.');
			process.exit(0);
		},
	});

	config.set('bitbucket', bb);
	config.set('jira', jira);
	config.set('confluence', confluence);
	config.set('serviceDesk', serviceDesk);

	p.outro(pc.green('Configuration saved!'));
	const setupGraph = await p.confirm({
		message: 'Configure Microsoft Graph for Teams, email, calendars, and SharePoint?',
		initialValue: false,
	});
	if (p.isCancel(setupGraph)) {
		p.cancel('Graph setup skipped.');
		return;
	}
	if (setupGraph) await runGraphSetup();
}

export default config;
