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
}

export default config;
