import test from 'ava';
import {
	NoTargetSpaceError,
	resolveTargetSpace,
	spaceFromWorktreePath,
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

test('a directory in a worktree belongs to that space', t => {
	const worktrees = '/home/u/.worktrees/repo';
	t.is(spaceFromWorktreePath(`${worktrees}/STA-1`, '/home/u', 'repo'), 'STA-1');
	t.is(
		spaceFromWorktreePath(`${worktrees}/STA-1/packages/app`, '/home/u', 'repo'),
		'STA-1',
	);
});

test('a directory outside the repo worktrees belongs to no space', t => {
	for (const directory of [
		'/home/u/.worktrees/repo',
		'/home/u/.worktrees/repo-other/STA-1',
		'/home/u/workspace/repo',
	]) {
		t.is(spaceFromWorktreePath(directory, '/home/u', 'repo'), undefined);
	}
});
