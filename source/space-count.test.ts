import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {getActiveSpaceCount} from './tmux.ts';
import {setRegistryPath, resetRegistryPath} from './space-registry.ts';

let tempCounter = 0;
function tempRegistryPath(): string {
	return path.join(
		os.tmpdir(),
		`pappardelle-space-count-test-${process.pid}-${Date.now()}-${tempCounter++}.json`,
	);
}

test.afterEach(() => {
	resetRegistryPath();
});

// ============================================================================
// getActiveSpaceCount uses the space registry (not tmux sessions)
// ============================================================================

test.serial('returns 0 when registry is empty', t => {
	setRegistryPath(tempRegistryPath());
	t.is(getActiveSpaceCount(), 0);
});

test.serial('returns count of registered spaces', t => {
	const p = tempRegistryPath();
	fs.mkdirSync(path.dirname(p), {recursive: true});
	fs.writeFileSync(p, JSON.stringify(['STA-100', 'STA-200', 'STA-300']));
	setRegistryPath(p);
	t.is(getActiveSpaceCount(), 3);
});

test.serial('returns 1 for a single registered space', t => {
	const p = tempRegistryPath();
	fs.mkdirSync(path.dirname(p), {recursive: true});
	fs.writeFileSync(p, JSON.stringify(['STA-100']));
	setRegistryPath(p);
	t.is(getActiveSpaceCount(), 1);
});

test.serial('returns 0 when registry file does not exist', t => {
	setRegistryPath(path.join(os.tmpdir(), `nonexistent-${Date.now()}.json`));
	t.is(getActiveSpaceCount(), 0);
});

test.serial('returns correct count after registry file changes', t => {
	const p = tempRegistryPath();
	fs.mkdirSync(path.dirname(p), {recursive: true});
	fs.writeFileSync(p, JSON.stringify(['STA-100', 'STA-200']));
	setRegistryPath(p);
	t.is(getActiveSpaceCount(), 2);
});
