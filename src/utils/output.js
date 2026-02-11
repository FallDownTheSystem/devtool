import pc from 'picocolors';
import Table from 'cli-table3';

const HIDE_CURSOR = '\x1B[?25l';
const SHOW_CURSOR = '\x1B[?25h';
const CLEAR_LINE = '\x1B[2K\r';

export function spinner(text) {
	return {
		start() {
			process.stdout.write(`${HIDE_CURSOR}${pc.dim('–')} ${text}`);
			return this;
		},
		success({ text: msg } = {}) {
			process.stdout.write(`${CLEAR_LINE}${pc.green('✓')} ${msg || text}${SHOW_CURSOR}\n`);
			return this;
		},
		error({ text: msg } = {}) {
			process.stdout.write(`${CLEAR_LINE}${pc.red('✗')} ${msg || text}${SHOW_CURSOR}\n`);
			return this;
		},
	};
}

export function table(head, rows, options = {}) {
	const t = new Table({
		head: head.map((h) => pc.bold(pc.cyan(h))),
		style: { head: [], border: [] },
		wordWrap: true,
		...options,
	});
	for (const row of rows) {
		t.push(row);
	}
	return t.toString();
}

export function heading(text) {
	console.log(`\n${pc.bold(pc.cyan(text))}`);
}

export function field(label, value) {
	if (value === undefined || value === null || value === '') return;
	console.log(`  ${pc.dim(label + ':')} ${value}`);
}

export function divider() {
	console.log(pc.dim('─'.repeat(60)));
}

export function success(text) {
	console.log(pc.green(`✓ ${text}`));
}

export function warn(text) {
	console.log(pc.yellow(`⚠ ${text}`));
}

export function error(text) {
	console.log(pc.red(`✗ ${text}`));
}

export function mask(str) {
	if (!str || str.length < 8) return '****';
	return str.slice(0, 4) + '•'.repeat(Math.min(str.length - 4, 16));
}

export { pc };
