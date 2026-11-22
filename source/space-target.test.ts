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

const checkout = {repoName: 'repo', mainRoot: '/w/repo'};

/** Identities in which every path is in `key`'s worktree. */
const allIn = (key: string) => () => ({
	atPath: () => ({
		kind: 'identity' as const,
		identity: {
			repo: 'repo',
			key,
			worktreePath: '/w',
			tmux: {socket: 's', agentSession: 'a', companionSession: 'c'},
		},
	}),
});

test('PAPPARDELLE_SPACE names the space wherever the caller runs', t => {
	t.deepEqual(
		callerSpace({
			env: {PAPPARDELLE_SPACE: 'STA-9'},
			cwd: '/w',
			checkout: {kind: 'checkout', checkout},
			identities: allIn('STA-1'),
		}),
		{kind: 'env', key: 'STA-9'},
	);
});

test('outside a git checkout only PAPPARDELLE_SPACE names a space', t => {
	const options = {
		cwd: '/w',
		checkout: {kind: 'not-in-a-repo'} as const,
		identities: allIn('STA-1'),
	};
	t.deepEqual(callerSpace({...options, env: {}}), {kind: 'none'});
	t.deepEqual(callerSpace({...options, env: {PAPPARDELLE_SPACE: 'STA-1'}}), {
		kind: 'env',
		key: 'STA-1',
	});
});
