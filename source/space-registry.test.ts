import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	getRegisteredSpaces,
	addSpace,
	removeSpace,
	isSpaceRegistered,
	seedFromTmux,
	setRegistryPath,
	resetRegistryPath,
} from './space-registry.ts';

let tempCounter = 0;
function tempRegistryPath(): string {
	return path.join(
		os.tmpdir(),
		`pappardelle-registry-test-${process.pid}-${Date.now()}-${tempCounter++}.json`,
	);
}

test.afterEach(() => {
	resetRegistryPath();
});

test.serial('returns empty array when no file exists', t => {
	setRegistryPath(tempRegistryPath());
	t.deepEqual(getRegisteredSpaces(), []);
});

test.serial('addSpace adds to registry and persists', t => {
	const p = tempRegistryPath();
	setRegistryPath(p);

	addSpace('STA-100');
	t.deepEqual(getRegisteredSpaces(), ['STA-100']);

	t.true(fs.existsSync(p));
	const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
	t.deepEqual(data, ['STA-100']);
});

test.serial('addSpace is a no-op for duplicates', t => {
	const p = tempRegistryPath();
	setRegistryPath(p);

	addSpace('STA-100');
	addSpace('STA-100');
	t.deepEqual(getRegisteredSpaces(), ['STA-100']);
});

test.serial('removeSpace removes from registry and persists', t => {
	const p = tempRegistryPath();
	setRegistryPath(p);

	addSpace('STA-100');
	addSpace('STA-200');
	removeSpace('STA-100');

	t.deepEqual(getRegisteredSpaces(), ['STA-200']);
	const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
	t.deepEqual(data, ['STA-200']);
});

test.serial('removeSpace is a no-op for missing keys', t => {
	const p = tempRegistryPath();
	setRegistryPath(p);

	addSpace('STA-100');
	removeSpace('STA-999');
	t.deepEqual(getRegisteredSpaces(), ['STA-100']);
});

test.serial('isSpaceRegistered returns correct boolean', t => {
	setRegistryPath(tempRegistryPath());

	addSpace('STA-100');
	t.true(isSpaceRegistered('STA-100'));
	t.false(isSpaceRegistered('STA-999'));
});

test.serial('loads persisted data from disk', t => {
	const p = tempRegistryPath();
	fs.writeFileSync(p, JSON.stringify(['STA-50', 'STA-60']) + '\n');

	setRegistryPath(p);
	t.deepEqual(getRegisteredSpaces(), ['STA-50', 'STA-60']);
});

test.serial('invalid JSON on disk is silently ignored', t => {
	const p = tempRegistryPath();
	fs.writeFileSync(p, '{{not json');

	setRegistryPath(p);
	t.deepEqual(getRegisteredSpaces(), []);
});

test.serial('filters out non-string values from disk', t => {
	const p = tempRegistryPath();
	fs.writeFileSync(p, JSON.stringify(['STA-1', 42, null, 'STA-2']) + '\n');

	setRegistryPath(p);
	t.deepEqual(getRegisteredSpaces(), ['STA-1', 'STA-2']);
});

test.serial('seedFromTmux adds missing keys', t => {
	const p = tempRegistryPath();
	setRegistryPath(p);

	addSpace('STA-100');
	seedFromTmux(['STA-100', 'STA-200', 'STA-300']);

	t.deepEqual(getRegisteredSpaces(), ['STA-100', 'STA-200', 'STA-300']);
});

test.serial('seedFromTmux is a no-op when all keys already present', t => {
	const p = tempRegistryPath();
	setRegistryPath(p);

	addSpace('STA-100');
	addSpace('STA-200');

	const stat1 = fs.statSync(p);
	seedFromTmux(['STA-100', 'STA-200']);
	const stat2 = fs.statSync(p);

	t.is(stat1.mtimeMs, stat2.mtimeMs);
});

test.serial('seedFromTmux works on empty registry', t => {
	setRegistryPath(tempRegistryPath());

	seedFromTmux(['STA-50', 'STA-60']);
	t.deepEqual(getRegisteredSpaces(), ['STA-50', 'STA-60']);
});
