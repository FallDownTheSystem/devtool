import { createRequire } from 'node:module';

// Secret connection fields (tokens) can live outside the config file. A field is looked up in order:
//   1. the config file                      (dev config set <connection>.token ...)
//   2. the environment variable             DEV_<CONNECTION>_<FIELD>, e.g. DEV_WORK_TOKEN
//   3. the OS credential store              service "devtool", account "<connection>.<field>"
// The connection is its label: its name, or its type when unnamed.

export const SERVICE = 'devtool';

export function account(label, field) {
	return `${label}.${field}`;
}

export function envName(label, field) {
	return `DEV_${label.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_${field.toUpperCase()}`;
}

let keyring;

// Loaded on first use, so commands that never need the credential store do not load its native binding.
function entry(name) {
	keyring ??= createRequire(import.meta.url)('@napi-rs/keyring');
	// Linux would otherwise fall back to the kernel keyring, which loses the secret at logout or reboot.
	return new keyring.Entry(SERVICE, name, { linux: { store: 'secret-service' } });
}

function storeError(err) {
	return new Error(`Cannot use the OS credential store (Windows Credential Manager, macOS Keychain, or Linux Secret Service): ${err.message}`, { cause: err });
}

// An object so tests can replace its methods.
export const credentialStore = {
	get(name) {
		try {
			return entry(name).getPassword();
		} catch (err) {
			throw storeError(err);
		}
	},
	set(name, value) {
		try {
			entry(name).setPassword(value);
		} catch (err) {
			throw storeError(err);
		}
	},
	delete(name) {
		try {
			return entry(name).deletePassword();
		} catch (err) {
			throw storeError(err);
		}
	},
};

// Where a secret field of a connection comes from: { value, source, error }. `source` is 'config',
// 'env', 'store', or undefined when it is set nowhere; `error` says why the store could not be read.
export function lookupSecret(connection, label, field) {
	if (connection[field]) return { value: connection[field], source: 'config' };
	const env = process.env[envName(label, field)];
	if (env) return { value: env, source: 'env' };
	try {
		const value = credentialStore.get(account(label, field));
		return value ? { value, source: 'store' } : {};
	} catch (err) {
		return { error: err };
	}
}
