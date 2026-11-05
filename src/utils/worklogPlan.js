import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

// A worklog plan for `dev tempo worklog add --file`: CSV or JSON rows of
//   date, key, hours, comment, worktype   (optional: start, wagetype, pricing, billable)
// A CSV without a header row has the first five columns in that order. A header row names its
// columns, in any order. Excel saves CSV with ";" in locales whose decimal mark is ",", so a first
// line with ";" and no "," sets the delimiter.

const COLUMNS = {
	date: 'date',
	key: 'key', issue: 'key', issuekey: 'key',
	hours: 'hours', time: 'hours',
	comment: 'comment', description: 'comment',
	worktype: 'workType',
	start: 'start', starttime: 'start',
	wagetype: 'wageType',
	pricing: 'pricing', pricingmultiplier: 'pricing',
	billable: 'billableHours', billablehours: 'billableHours',
};

const POSITIONAL = ['date', 'key', 'hours', 'comment', 'workType'];

const columnOf = (name) => COLUMNS[String(name).toLowerCase().replace(/[^a-z]/g, '')];

// RFC 4180 records: quoted fields may hold the delimiter, quotes ("") and line breaks.
export function parseCsv(text, delimiter = ',') {
	const records = [];
	let record = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
			else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"' && field === '') {
			quoted = true;
		} else if (c === delimiter) {
			record.push(field);
			field = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++;
			record.push(field);
			records.push(record);
			record = [];
			field = '';
		} else {
			field += c;
		}
	}
	if (quoted) throw new Error('The CSV has a quoted field without its closing quote.');
	if (field !== '' || record.length) {
		record.push(field);
		records.push(record);
	}
	return records.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function delimiterOf(text) {
	const first = text.split(/\r?\n/, 1)[0];
	return first.includes(';') && !first.includes(',') ? ';' : ',';
}

function clean(row) {
	return Object.fromEntries(Object.entries(row)
		.map(([k, v]) => [k, v === undefined || v === null ? '' : String(v).trim()])
		.filter(([, v]) => v !== ''));
}

function fromCsv(text) {
	const records = parseCsv(text, delimiterOf(text));
	if (!records.length) return [];
	const header = records[0].map(columnOf);
	const named = header.includes('date') && header.includes('key');
	if (named) {
		const unknown = records[0].filter((name, i) => name.trim() && !header[i]);
		if (unknown.length) throw new Error(`Unknown column(s) ${unknown.join(', ')}. Columns: date, key, hours, comment, worktype, start, wagetype, pricing, billable.`);
	}
	const columns = named ? header : POSITIONAL;
	return (named ? records.slice(1) : records).map((cells, i) => {
		if (!named && cells.length > POSITIONAL.length) {
			throw new Error(`Row ${i + 1} has ${cells.length} columns; a CSV without a header has ${POSITIONAL.join(', ')}. Quote a comment that holds the delimiter.`);
		}
		return clean(Object.fromEntries(cells.map((cell, c) => [columns[c], cell]).filter(([column]) => column)));
	});
}

function fromJson(text) {
	const data = JSON.parse(text);
	if (!Array.isArray(data)) throw new Error('A JSON plan is an array of worklogs, e.g. [{"date":"2026-11-02","key":"PROJ-1","hours":1.5}].');
	return data.map((item, i) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Item ${i + 1} of the JSON plan is not an object.`);
		const row = {};
		for (const [name, value] of Object.entries(item)) {
			const column = columnOf(name);
			if (!column) throw new Error(`Unknown field "${name}" in item ${i + 1}. Fields: date, key, hours, comment, workType, start, wageType, pricing, billableHours.`);
			row[column] = value;
		}
		return clean(row);
	});
}

// Rows of { date, key, hours, comment, workType, start, wageType, pricing, billableHours }, all text.
export function readPlan(path) {
	const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
	const rows = extname(path).toLowerCase() === '.json' ? fromJson(text) : fromCsv(text);
	if (!rows.length) throw new Error(`${path} has no worklogs.`);
	return rows;
}
