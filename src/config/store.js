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
};

const config = new Conf({
	projectName: 'devtool',
	schema,
	defaults: {
		bitbucket: { workspace: '', defaultRepo: '', email: '', token: '' },
		jira: { baseUrl: '', token: '', defaultProject: '' },
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

	config.set('bitbucket', bb);
	config.set('jira', jira);

	p.outro(pc.green('Configuration saved!'));
}

export default config;
