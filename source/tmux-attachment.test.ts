import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'ava';
import {LatestTask} from './latest-task.ts';
import {
	attachToSpace,
	clearCurrentlyViewingSpace,
	getCurrentlyViewingSpace,
	ensureCompanionSession,
	type AsyncTmuxRunner,
} from './tmux.ts';

function fakeTmux() {
	const calls: string[][] = [];
	const run: AsyncTmuxRunner = async args => {
		calls.push(args);
		if (args[0] === 'display-message')
			return args[3] === '%1' ? '/dev/claude' : '/dev/companion';
		if (args.includes('list-clients')) return '/dev/claude\n/dev/companion\n';
		return '';
	};
	return {calls, run};
}

test.beforeEach(() => {
	clearCurrentlyViewingSpace();
});

test.serial(
	'switching yields to input and sends both clients to the selected inner sessions',
	async t => {
		const fake = fakeTmux();
		let release = () => {};
		const wait = new Promise<void>(resolve => {
			release = resolve;
		});
		let finished = false;
		const run: AsyncTmuxRunner = async args => {
			await wait;
			return fake.run(args);
		};
		const attaching = attachToSpace(
			'%1',
			'%2',
			'TEST-1',
			'%0',
			undefined,
			undefined,
			{run},
		).then(result => {
			finished = true;
			return result;
		});
		await nextTurn();
		t.false(finished);
		release();
		t.true(await attaching);
		const switches = fake.calls.filter(args => args.includes('switch-client'));
		t.is(switches.length, 2);
		t.true(
			switches.every(
				args => args[0] === '-L' && args[1] === 'pappardelle_inner',
			),
		);
		t.true(switches[0]!.at(-1)!.endsWith('-TEST-1'));
		t.true(switches[1]!.at(-1)!.endsWith('-TEST-1'));
		t.deepEqual(fake.calls.at(-1), ['select-pane', '-t', '%0']);
	},
);

test.serial(
	'a superseded partial switch can return to the previously viewed space',
	async t => {
		const fake = fakeTmux();
		t.true(
			await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
				run: fake.run,
			}),
		);
		fake.calls.length = 0;
		const controller = new AbortController();
		const run: AsyncTmuxRunner = async args => {
			const output = await fake.run(args);
			if (args.includes('switch-client')) controller.abort();
			return output;
		};
		t.false(
			await attachToSpace('%1', '%2', 'TEST-B', '%0', undefined, undefined, {
				run,
				signal: controller.signal,
			}),
		);
		t.is(getCurrentlyViewingSpace(), null);
		t.is(fake.calls.filter(args => args.includes('switch-client')).length, 1);
		fake.calls.length = 0;
		t.true(
			await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
				run: fake.run,
			}),
		);
		t.deepEqual(
			fake.calls.map(args => args.includes('switch-client')),
			[true, false],
		);
		t.true(fake.calls[0]!.includes(';'));
		t.is(getCurrentlyViewingSpace(), 'TEST-A');
	},
);

test.serial(
	'warm switches move both viewers in one request without setup probes',
	async t => {
		const fake = fakeTmux();
		await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
			run: fake.run,
		});
		fake.calls.length = 0;
		t.true(
			await attachToSpace('%1', '%2', 'TEST-B', '%0', undefined, undefined, {
				run: fake.run,
			}),
		);
		t.is(fake.calls.length, 2);
		const batch = fake.calls[0]!;
		t.deepEqual(batch.slice(0, 6), [
			'-L',
			'pappardelle_inner',
			'switch-client',
			'-c',
			'/dev/claude',
			'-t',
		]);
		t.true(batch[6]!.startsWith('=claude-'));
		t.true(batch[6]!.endsWith('-TEST-B'));
		t.deepEqual(batch.slice(7, 12), [
			';',
			'switch-client',
			'-c',
			'/dev/companion',
			'-t',
		]);
		t.true(batch[12]!.startsWith('=companion-'));
		t.true(batch[12]!.endsWith('-TEST-B'));
		t.deepEqual(fake.calls[1], ['select-pane', '-t', '%0']);
	},
);

test.serial(
	'an invalid warm cache falls back and retries both viewers after a partial batch',
	async t => {
		const fake = fakeTmux();
		await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
			run: fake.run,
		});
		fake.calls.length = 0;
		const run: AsyncTmuxRunner = async args => {
			const output = await fake.run(args);
			if (args.includes(';')) throw new Error('second client disappeared');
			if (args[0] === 'display-message') {
				return args[3] === '%1' ? '/dev/new-claude' : '/dev/new-companion';
			}
			if (args.includes('list-clients')) {
				return '/dev/new-claude\n/dev/new-companion\n';
			}
			return output;
		};
		t.true(
			await attachToSpace('%1', '%2', 'TEST-B', '%0', undefined, undefined, {
				run,
			}),
		);
		const retries = fake.calls.filter(
			args => args.includes('switch-client') && !args.includes(';'),
		);
		t.is(retries.length, 2);
		t.deepEqual(
			retries.map(args => args[4]),
			['/dev/new-claude', '/dev/new-companion'],
		);
		t.true(retries.every(args => args.at(-1)!.endsWith('-TEST-B')));
		t.is(getCurrentlyViewingSpace(), 'TEST-B');
	},
);

test.serial(
	'replaced viewer panes invalidate TTYs even for the same selected workspace',
	async t => {
		const fake = fakeTmux();
		await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
			run: fake.run,
		});
		fake.calls.length = 0;
		t.true(
			await attachToSpace('%3', '', 'TEST-A', '%0', undefined, undefined, {
				run: fake.run,
			}),
		);
		t.true(
			fake.calls.some(
				args => args[0] === 'display-message' && args[3] === '%3',
			),
		);
		t.false(fake.calls.some(args => args.includes(';')));
	},
);

test.serial(
	'rapid navigation skips stale selections while tmux is still responding',
	async t => {
		const fake = fakeTmux();
		const task = new LatestTask();
		let release = () => {};
		const wait = new Promise<void>(resolve => {
			release = resolve;
		});
		const run: AsyncTmuxRunner = async args => {
			await wait;
			return fake.run(args);
		};
		const select = async (key: string) =>
			task.run(async signal => {
				await attachToSpace('%1', '%2', key, '%0', undefined, undefined, {
					run,
					signal,
				});
			});
		const first = select('TEST-A');
		await nextTurn();
		const second = select('TEST-B');
		const third = select('TEST-C');
		release();
		await Promise.all([first, second, third]);
		const targets = fake.calls
			.filter(args => args.includes('switch-client'))
			.map(args => args.at(-1));
		t.is(targets.length, 2);
		t.true(targets.every(target => target!.endsWith('-TEST-C')));
		t.false(fake.calls.some(args => args.some(arg => arg.endsWith('-TEST-B'))));
		t.is(getCurrentlyViewingSpace(), 'TEST-C');
	},
);

test.serial(
	'a failed tmux switch is reported as failure and can be retried',
	async t => {
		const fake = fakeTmux();
		const run: AsyncTmuxRunner = async args => {
			if (args.includes('switch-client')) throw new Error('client disappeared');
			return fake.run(args);
		};
		t.false(
			await attachToSpace('%1', '%2', 'TEST-FAIL', '%0', undefined, undefined, {
				run,
			}),
		);
		t.is(getCurrentlyViewingSpace(), null);
		t.true(
			await attachToSpace('%1', '%2', 'TEST-FAIL', '%0', undefined, undefined, {
				run: fake.run,
			}),
		);
	},
);

test.serial(
	'cold companion creation completes its command before reporting success',
	async t => {
		const calls: string[][] = [];
		const run: AsyncTmuxRunner = async args => {
			calls.push(args);
			if (args.includes('has-session')) throw new Error('no session');
			return '';
		};
		t.true(await ensureCompanionSession('TEST-NEW', '/tmp', 'custom-ui', run));
		t.deepEqual(
			calls.map(args => args[2]),
			['has-session', 'new-session', 'send-keys'],
		);
		t.true(
			calls.every(args => args[0] === '-L' && args[1] === 'pappardelle_inner'),
		);
		t.true(calls[1]!.includes('PAPPARDELLE_SPACE=TEST-NEW'));
		t.true(calls[2]!.includes('custom-ui'));
	},
);
