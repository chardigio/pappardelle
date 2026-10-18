import test from 'ava';
import {NoTargetSpaceError, resolveTargetSpace} from './space-target.ts';

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
