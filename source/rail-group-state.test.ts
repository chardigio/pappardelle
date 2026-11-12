import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	getRailGroupStatePath,
	readCollapsedGroups,
	writeCollapsedGroups,
} from './rail-group-state.ts';

function tempBase(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'rail-groups-'));
}

const known = ['in progress', 'in review', 'done'];

test('collapsed groups survive a write and read', t => {
	const base = tempBase();
	writeCollapsedGroups('repo', new Set(['done', 'in review']), base);
	t.deepEqual([...readCollapsedGroups('repo', known, base)].sort(), [
		'done',
		'in review',
	]);
});

test('a missing or malformed file starts every group expanded', t => {
	const base = tempBase();
	t.is(readCollapsedGroups('repo', known, base).size, 0);
	const file = getRailGroupStatePath('repo', base);
	fs.mkdirSync(path.dirname(file), {recursive: true});
	fs.writeFileSync(file, '{not json');
	t.is(readCollapsedGroups('repo', known, base).size, 0);
});

test('groups no longer configured are dropped on read', t => {
	const base = tempBase();
	writeCollapsedGroups('repo', new Set(['done', 'qa', 'agents']), base);
	t.deepEqual([...readCollapsedGroups('repo', known, base)], ['done']);
});
