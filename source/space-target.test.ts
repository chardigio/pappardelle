import fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	callerSpace,
	NoTargetSpaceError,
	resolveTargetSpace,
} from './space-target.ts';

const resolve = (raw: string) => `resolved:${raw}`;

test('--space resolves like a typed issue key', t => {
	t.is(
		resolveTargetSpace({
			flag: '696',
			env: {PAPPARDELLE_SPACE: 'STA-1'},
			resolve,
		}),
		'resolved:696',
	);
});

test('PAPPARDELLE_SPACE is the exact key and is not normalized', t => {
	t.is(
		resolveTargetSpace({env: {PAPPARDELLE_SPACE: 'DEMO-2'}, resolve}),
		'DEMO-2',
	);
});

test('with neither, the caller is told it is not in a workspace', t => {
	for (const env of [{}, {PAPPARDELLE_SPACE: ' '}]) {
		t.throws(() => resolveTargetSpace({env, resolve}), {
			instanceOf: NoTargetSpaceError,
		});
	}
});

/** A home with the main checkout and worktrees `STA-1` and `a.b_c` of `repo`. */
function layout() {
	const home = fs.mkdtempSync(path.join(tmpdir(), 'space-target-'));
	const mainRoot = path.join(home, 'workspace', 'repo');
	const worktrees = path.join(home, '.worktrees', 'repo');
	const checkout = {repoName: 'repo', mainRoot};
	for (const directory of [
		path.join(mainRoot, 'src'),
		path.join(worktrees, 'STA-1', 'packages', 'app'),
		path.join(worktrees, 'a.b_c'),
		path.join(home, '.worktrees', 'repo-other', 'STA-2'),
	])
		fs.mkdirSync(directory, {recursive: true});
	const caller = (cwd: string, env: NodeJS.ProcessEnv = {}) =>
		callerSpace({env, cwd, home, checkout: {kind: 'checkout', checkout}});
	const inSpace = (key: string) => ({kind: 'cwd', key, checkout});
	return {home, mainRoot, worktrees, caller, inSpace};
}

test('PAPPARDELLE_SPACE names the space wherever the caller runs', t => {
	const {mainRoot, caller} = layout();
	t.deepEqual(caller(mainRoot, {PAPPARDELLE_SPACE: 'STA-9'}), {
		kind: 'env',
		key: 'STA-9',
	});
});

test('a directory in a worktree belongs to that space', t => {
	const {worktrees, caller, inSpace} = layout();
	t.deepEqual(caller(path.join(worktrees, 'STA-1')), inSpace('STA-1'));
	t.deepEqual(
		caller(path.join(worktrees, 'STA-1', 'packages', 'app')),
		inSpace('STA-1'),
	);
	t.deepEqual(caller(path.join(worktrees, 'a.b_c')), inSpace('a.b_c'));
});

test('a symlink to a worktree belongs to that space', t => {
	const {home, worktrees, caller, inSpace} = layout();
	const link = path.join(home, 'link');
	fs.symlinkSync(path.join(worktrees, 'STA-1', 'packages'), link);
	t.deepEqual(caller(path.join(link, 'app')), inSpace('STA-1'));
});

test('the main checkout and its subdirectories are the main space', t => {
	const {mainRoot, caller, inSpace} = layout();
	t.deepEqual(caller(mainRoot), inSpace('main'));
	t.deepEqual(caller(path.join(mainRoot, 'src')), inSpace('main'));
});

test('a directory outside the checkouts belongs to no space', t => {
	const {home, worktrees, caller} = layout();
	for (const directory of [
		worktrees,
		path.join(home, '.worktrees', 'repo-other', 'STA-2'),
		path.join(home, 'workspace'),
	]) {
		t.deepEqual(caller(directory), {kind: 'none'});
	}
});

test('outside a git checkout only PAPPARDELLE_SPACE names a space', t => {
	const {worktrees} = layout();
	const options = {cwd: path.join(worktrees, 'STA-1'), home: '/nowhere'};
	const outside = {kind: 'not-in-a-repo'} as const;
	t.deepEqual(callerSpace({...options, env: {}, checkout: outside}), {
		kind: 'none',
	});
	t.deepEqual(
		callerSpace({
			...options,
			env: {PAPPARDELLE_SPACE: 'STA-1'},
			checkout: outside,
		}),
		{kind: 'env', key: 'STA-1'},
	);
});
