import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {StateColorCache} from './providers/state-color-cache.ts';

let tempCounter = 0;
function tempCachePath(): string {
	return path.join(
		os.tmpdir(),
		`pappardelle-scc-test-${process.pid}-${Date.now()}-${tempCounter++}.json`,
	);
}

test('get returns null for unknown state', t => {
	const cache = new StateColorCache(tempCachePath());
	t.is(cache.get('Unknown'), null);
});

test('update stores color in memory', t => {
	const cache = new StateColorCache(tempCachePath());
	cache.update('Done', '#74d09f');
	t.is(cache.get('Done'), '#74d09f');
});

test('update persists to disk', t => {
	const p = tempCachePath();
	const cache = new StateColorCache(p);
	cache.update('In Progress', '#f2c94c');

	t.true(fs.existsSync(p));
	const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
	t.is(data['In Progress'], '#f2c94c');
});

test('constructor loads persisted colors from disk', t => {
	const p = tempCachePath();
	fs.writeFileSync(p, JSON.stringify({Done: '#aaa', Todo: '#bbb'}) + '\n');

	const cache = new StateColorCache(p);
	t.is(cache.get('Done'), '#aaa');
	t.is(cache.get('Todo'), '#bbb');
});

test('update does not write when color is unchanged', t => {
	const p = tempCachePath();
	const cache = new StateColorCache(p);
	cache.update('Done', '#74d09f');

	const stat1 = fs.statSync(p);
	cache.update('Done', '#74d09f');
	const stat2 = fs.statSync(p);

	t.is(stat1.mtimeMs, stat2.mtimeMs);
});

test('invalid JSON on disk is silently ignored', t => {
	const p = tempCachePath();
	fs.writeFileSync(p, '{{not json');

	const cache = new StateColorCache(p);
	t.is(cache.get('Done'), null);
});

test('missing file on disk is silently ignored', t => {
	const cache = new StateColorCache(tempCachePath());
	t.is(cache.get('Done'), null);
});

test('multiple updates accumulate in the persisted file', t => {
	const p = tempCachePath();
	const cache = new StateColorCache(p);
	cache.update('Done', '#aaa');
	cache.update('In Progress', '#bbb');
	cache.update('Todo', '#ccc');

	const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
	t.is(data['Done'], '#aaa');
	t.is(data['In Progress'], '#bbb');
	t.is(data['Todo'], '#ccc');
});
