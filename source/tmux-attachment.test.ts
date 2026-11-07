import {setImmediate as nextTurn} from 'node:timers/promises';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {LatestTask} from './latest-task.ts';
import {
	attachToSpace,
	clearCurrentlyViewingSpace,
	getCurrentlyViewingSpace,
	ensureAgentSession,
	ensureCompanionSession,
	killSpaceSessions,
	type AsyncTmuxRunner,
} from './tmux.ts';
import {clearRecentErrors, getRecentErrors} from './logger.ts';
import {shellQuote} from './shell-quote.ts';
import {attachStatusMonitor} from './program-status-monitor.ts';
import {
	StartupTrace,
	startupTrace,
	type StartupRecord,
} from './startup-trace.ts';

test.serial(
	'background monitor discovery does not consume the selected startup trace',
	async t => {
		const records: StartupRecord[] = [];
		const previous = startupTrace.current;
		startupTrace.current = new StartupTrace({
			pid: 1,
			now: () => 0,
			write: record => records.push(record),
			schedule: () => () => {},
		});
		t.teardown(() => {
			startupTrace.current = previous;
		});
		await attachStatusMonitor(
			'fixture',
			'background',
			'agent-background',
			'fixture',
			async () => '',
		);
		t.false(records.some(record => record.stage === 'monitor-ready'));
		await ensureAgentSession('TEST-SELECTED', undefined, false, async () => '');
		t.is(
			records.filter(
				record => record.stage === 'monitor-ready' && record.phase === 'begin',
			).length,
			1,
		);
	},
);

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

function isolatedHome(t: ExecutionContext): string {
	const home = mkdtempSync(join(tmpdir(), 'pappa-cold-attach-'));
	const previous = process.env['HOME'];
	process.env['HOME'] = home;
	t.teardown(() => {
		if (previous === undefined) delete process.env['HOME'];
		else process.env['HOME'] = previous;
		rmSync(home, {recursive: true, force: true});
	});
	return home;
}

for (const delayed of ['agent-gate', 'companion-create']) {
	test.serial(
		`cold cancellation drains ${delayed} and delivers both launch commands before the next selection`,
		async t => {
			const home = isolatedHome(t);
			const queue = new LatestTask();
			const calls: string[][] = [];
			let release = () => {};
			const pending = new Promise<void>(resolve => {
				release = resolve;
			});
			let blocked = false;
			let finished = false;
			const run: AsyncTmuxRunner = async args => {
				calls.push(args);
				const cold = args.some(arg => arg.includes('TEST-COLD'));
				if (cold && args.includes('has-session')) throw new Error('no session');
				if (
					cold &&
					((delayed === 'agent-gate' && args.includes('if-shell')) ||
						(delayed === 'companion-create' &&
							args.includes('new-session') &&
							args.some(arg => arg.startsWith('companion-'))))
				) {
					blocked = true;
					await pending;
				}
				if (args[0] === 'display-message')
					return args[3] === '%1' ? '/dev/agent' : '/dev/companion';
				if (args.includes('list-clients')) return '/dev/agent\n/dev/companion';
				return '';
			};
			const select = async (key: string) =>
				queue.run(async signal => {
					await attachToSpace('%1', '%2', key, '%0', home, undefined, {
						run,
						signal,
					});
				});
			const first = select('TEST-COLD').then(() => {
				finished = true;
			});
			await nextTurn();
			t.true(blocked);
			const next = select('TEST-NEXT');
			await nextTurn();
			t.false(finished);
			t.false(calls.some(args => args.some(arg => arg.includes('TEST-NEXT'))));
			release();
			await Promise.all([first, next]);
			const creations = calls.filter(args => args.includes('new-session'));
			t.is(creations.length, 2);
			const agent = creations.find(args =>
				args.some(arg => arg.startsWith('agent-')),
			)!;
			const companion = creations.find(args =>
				args.some(arg => arg.startsWith('companion-')),
			)!;
			t.true(agent.some(arg => arg.includes('wait-for')));
			for (const creation of [agent, companion]) {
				const shell = creation.findIndex(arg => arg.includes('"$1" -ic "$2'));
				t.true(shell !== -1);
				t.truthy(creation[shell + 3]?.trim());
			}
			const gate = calls.findIndex(
				args =>
					args.includes('if-shell') &&
					args.some(arg => arg.includes('TEST-COLD')),
			);
			const nextStart = calls.findIndex(args =>
				args.some(arg => arg.includes('TEST-NEXT')),
			);
			t.true(gate !== -1 && gate < nextStart);
			t.is(getCurrentlyViewingSpace(), 'TEST-NEXT');
		},
	);
}

for (const delayed of ['%1', '%2']) {
	for (const cancelled of [false, true]) {
		test.serial(
			`cold viewer respawn ${cancelled ? 'cancellation' : 'failure'} drains ${delayed} before recovery`,
			async t => {
				const queue = new LatestTask();
				const started = new Set<string>();
				let release = () => {};
				const pending = new Promise<void>(resolve => {
					release = resolve;
				});
				let recovering = false;
				let finished = false;
				const run: AsyncTmuxRunner = async args => {
					if (args.includes('list-clients')) return '';
					if (args[0] === 'display-message') return `/dev/${args[3]}`;
					if (!recovering && args[0] === 'respawn-pane') {
						const pane = args[args.indexOf('-t') + 1]!;
						started.add(pane);
						if (pane === delayed) await pending;
						else if (!cancelled) throw new Error('respawn failed');
					}
					return '';
				};
				const first = queue.run(async signal => {
					t.false(
						await attachToSpace(
							'%1',
							'%2',
							'TEST-COLD',
							'%0',
							undefined,
							undefined,
							{run, signal},
						),
					);
					finished = true;
				});
				await nextTurn();
				t.deepEqual([...started].sort(), ['%1', '%2']);
				if (cancelled) queue.cancel();
				const next = queue.exclusive(async () => {
					recovering = true;
					t.true(
						await attachToSpace(
							'%1',
							'%2',
							'TEST-RECOVER',
							'%0',
							undefined,
							undefined,
							{run},
						),
					);
				});
				await nextTurn();
				t.false(finished);
				t.false(recovering);
				release();
				await Promise.all([first, next]);
				t.is(getCurrentlyViewingSpace(), 'TEST-RECOVER');
			},
		);
	}
}

const isSwitchBatch = (args: string[]) =>
	args.includes('switch-client') && args.includes(';');

for (const delayed of ['agent', 'companion']) {
	test.serial(
		`superseding selection waits for pending ${delayed} preparation`,
		async t => {
			const fake = fakeTmux();
			const task = new LatestTask();
			let release = () => {};
			const pending = new Promise<void>(resolve => {
				release = resolve;
			});
			const started = new Set<string>();
			let firstFinished = false;
			const run: AsyncTmuxRunner = async args => {
				if (
					args.includes('has-session') &&
					args.some(arg => arg.endsWith('-TEST-A:'))
				) {
					const kind = args.some(arg => arg.startsWith('=companion-'))
						? 'companion'
						: 'agent';
					started.add(kind);
					if (kind === delayed) await pending;
				}
				return fake.run(args);
			};
			const select = async (key: string) =>
				task.run(async signal => {
					await attachToSpace('%1', '%2', key, '%0', undefined, undefined, {
						run,
						signal,
					});
				});
			const first = select('TEST-A').then(() => {
				firstFinished = true;
			});
			await nextTurn();
			t.deepEqual([...started].sort(), ['agent', 'companion']);
			const second = select('TEST-B');
			await nextTurn();
			t.false(firstFinished);
			t.is(getCurrentlyViewingSpace(), null);
			t.false(
				fake.calls.some(args => args.some(arg => arg.includes('TEST-B'))),
			);
			release();
			await Promise.all([first, second]);
			t.is(getCurrentlyViewingSpace(), 'TEST-B');
			t.false(
				fake.calls.some(
					args =>
						args.includes('switch-client') &&
						args.some(arg => arg.endsWith('-TEST-A:')),
				),
			);
		},
	);
}

const titleAndFocus = (issueKey: string) => [
	'set-option',
	'-p',
	'-t',
	'%1',
	'@pappardelle_title',
	`agent · ${issueKey}`,
	';',
	'select-pane',
	'-t',
	'%0',
];

for (const {delayed, cancel} of [
	{delayed: '/dev/claude', cancel: false},
	{delayed: '/dev/companion', cancel: false},
	{delayed: '/dev/claude', cancel: true},
	{delayed: '/dev/companion', cancel: true},
]) {
	test.serial(
		`${cancel ? 'cancelled' : 'failed'} viewer waits for sibling on ${delayed} before allowing retry`,
		async t => {
			const fake = fakeTmux();
			const controller = new AbortController();
			let release = () => {};
			const pending = new Promise<void>(resolve => {
				release = resolve;
			});
			const started = new Set<string>();
			let finished = false;
			const run: AsyncTmuxRunner = async args => {
				if (args.includes('switch-client')) {
					const tty = args[args.indexOf('-c') + 1]!;
					started.add(tty);
					if (tty === delayed) await pending;
					else if (!cancel) throw new Error('client disappeared');
				}
				return fake.run(args);
			};
			const attaching = attachToSpace(
				'%1',
				'%2',
				'TEST-FAIL',
				'%0',
				undefined,
				undefined,
				{run, signal: controller.signal},
			).then(result => {
				finished = true;
				return result;
			});
			await nextTurn();
			t.is(started.size, 2);
			if (cancel) controller.abort();
			t.false(finished);
			t.is(getCurrentlyViewingSpace(), null);
			release();
			t.false(await attaching);
			t.false(fake.calls.some(args => args.includes('@pappardelle_title')));
			fake.calls.length = 0;
			t.true(
				await attachToSpace(
					'%1',
					'%2',
					'TEST-RECOVER',
					'%0',
					undefined,
					undefined,
					{run: fake.run},
				),
			);
			t.false(fake.calls.some(args => isSwitchBatch(args)));
			t.is(getCurrentlyViewingSpace(), 'TEST-RECOVER');
		},
	);
}

test.beforeEach(() => {
	clearCurrentlyViewingSpace();
});

test.serial(
	'failed cold respawn discards cached ttys before a recycled pty can target the other viewer',
	async t => {
		let phase = 'empty';
		const ttys = new Map([
			['%1', '/dev/old-agent'],
			['%2', '/dev/old-companion'],
		]);
		const destinations = new Map<string, string>();
		const run: AsyncTmuxRunner = async args => {
			if (args.includes('has-session') && phase === 'empty')
				throw new Error('no session');
			if (args[0] === 'display-message') {
				const pane = args[3]!;
				if (phase === 'failed' && pane === '%2')
					throw new Error('tty query failed after respawn');
				return ttys.get(pane)!;
			}
			if (args.includes('list-clients'))
				return phase === 'retry' ? [...ttys.values()].join('\n') : '';
			if (args[0] === 'respawn-pane' && phase === 'failed') {
				const pane = args[args.indexOf('-t') + 1]!;
				ttys.set(pane, pane === '%1' ? '/dev/new-agent' : '/dev/old-agent');
			}
			if (args.includes('switch-client')) {
				const tty = args[args.indexOf('-c') + 1]!;
				const pane = [...ttys].find(([, value]) => value === tty)?.[0];
				if (!pane) throw new Error('client not found');
				destinations.set(pane, args[args.indexOf('-t') + 1]!);
			}
			return '';
		};
		const attach = async (key: string) =>
			attachToSpace('%1', '%2', key, '%0', undefined, undefined, {run});
		t.true(await attach('TEST-EMPTY'));
		phase = 'failed';
		t.false(await attach('TEST-FAILED'));
		phase = 'retry';
		t.true(await attach('TEST-RETRY'));
		t.true(destinations.get('%1')?.startsWith('=agent-'));
		t.true(destinations.get('%2')?.startsWith('=companion-'));
		t.true(
			[...destinations.values()].every(value => value.endsWith('-TEST-RETRY:')),
		);
	},
);

for (const selected of ['qa-custom', "/tmp/socket with ' quotes"]) {
	test.serial(
		`cold viewers attach to the selected socket ${selected}`,
		async t => {
			const previous = process.env['PAPPARDELLE_TMUX_SOCKET'];
			process.env['PAPPARDELLE_TMUX_SOCKET'] = selected;
			t.teardown(() => {
				if (previous === undefined)
					delete process.env['PAPPARDELLE_TMUX_SOCKET'];
				else process.env['PAPPARDELLE_TMUX_SOCKET'] = previous;
			});
			const fake = fakeTmux();
			const run: AsyncTmuxRunner = async args => {
				if (args.includes('list-clients')) {
					fake.calls.push(args);
					return '';
				}
				return fake.run(args);
			};
			t.true(
				await attachToSpace(
					'%1',
					'%2',
					'TEST-SOCKET',
					'%0',
					undefined,
					undefined,
					{run},
				),
			);
			const commands = fake.calls
				.filter(args => args.includes('respawn-pane'))
				.map(args => args.at(-1)!);
			t.is(commands.length, 2);
			for (const command of commands) {
				t.true(
					command.includes(
						`${shellQuote(selected.startsWith('/') ? '-S' : '-L')} ${shellQuote(selected)}`,
					),
				);
				t.false(command.includes('TMUX='));
				t.true(command.includes('TEST-SOCKET:'));
			}
		},
	);
}

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
		t.true(switches[0]!.at(-1)!.endsWith('-TEST-1:'));
		t.true(switches[1]!.at(-1)!.endsWith('-TEST-1:'));
		t.deepEqual(fake.calls.at(-1), titleAndFocus('TEST-1'));
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
		t.true(batch[6]!.startsWith('=agent-'));
		t.true(batch[6]!.endsWith('-TEST-B:'));
		t.deepEqual(batch.slice(7, 12), [
			';',
			'switch-client',
			'-c',
			'/dev/companion',
			'-t',
		]);
		t.true(batch[12]!.startsWith('=companion-'));
		t.true(batch[12]!.endsWith('-TEST-B:'));
		t.deepEqual(fake.calls[1], titleAndFocus('TEST-B'));
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
			if (isSwitchBatch(args)) throw new Error('second client disappeared');
			if (args[0] === 'display-message') {
				return args[3] === '%1' ? '/dev/new-claude' : '/dev/new-companion';
			}
			if (args.includes('list-clients')) {
				return '/dev/new-claude\n/dev/new-companion\n';
			}
			return output;
		};
		clearRecentErrors();
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
		t.true(retries.every(args => args.at(-1)!.endsWith('-TEST-B:')));
		t.is(getCurrentlyViewingSpace(), 'TEST-B');
		t.true(
			getRecentErrors().some(error =>
				error.message.includes('Fast workspace switch to TEST-B failed'),
			),
		);
	},
);

test.serial(
	'a first switch to a workspace without sessions falls back without reporting an error',
	async t => {
		const fake = fakeTmux();
		await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
			run: fake.run,
		});
		const run: AsyncTmuxRunner = async args => {
			const output = await fake.run(args);
			if (isSwitchBatch(args)) {
				throw Object.assign(new Error('Command failed'), {
					code: 1,
					stderr: "can't find session: agent-TEST-B\n",
				});
			}

			return output;
		};
		clearRecentErrors();
		t.true(
			await attachToSpace('%1', '%2', 'TEST-B', '%0', undefined, undefined, {
				run,
			}),
		);
		t.is(getCurrentlyViewingSpace(), 'TEST-B');
		t.deepEqual(getRecentErrors(), []);
	},
);

test.serial(
	'an absent inner server displays no-session state without hiding real client-query errors',
	async t => {
		const fake = fakeTmux();
		const missing = Object.assign(new Error('no server'), {
			code: 1,
			stderr: 'no server running on /tmp/fixture',
		});
		const run: AsyncTmuxRunner = async args => {
			if (args.includes('has-session') || args.includes('list-clients'))
				throw missing;
			return fake.run(args);
		};
		clearRecentErrors();
		await attachToSpace(
			'%1',
			'',
			'ABSENT-FIXTURE-999999',
			'%0',
			undefined,
			undefined,
			{run},
		);
		t.true(
			fake.calls.some(args =>
				args.some(
					arg =>
						arg.includes('has no agent running') &&
						arg.includes('ABSENT-FIXTURE-999999'),
				),
			),
		);
		t.false(
			getRecentErrors().some(error =>
				error.message.includes('Failed to attach'),
			),
		);
		clearCurrentlyViewingSpace();
		const denied: AsyncTmuxRunner = async args => {
			if (args.includes('list-clients'))
				throw Object.assign(new Error('permission denied'), {
					code: 1,
					stderr: 'Permission denied',
				});
			return fake.run(args);
		};
		t.false(
			await attachToSpace('%1', '', 'TEST-DENIED', '%0', undefined, undefined, {
				run: denied,
			}),
		);
		t.true(
			getRecentErrors().some(error =>
				error.message.includes('Failed to attach'),
			),
		);
	},
);

test.serial(
	'companion teardown failure leaves Claude alive and reattachment sends no launch command',
	async t => {
		const fake = fakeTmux();
		await attachToSpace('%1', '%2', 'TEST-KEEP', '%0', undefined, undefined, {
			run: fake.run,
		});
		fake.calls.length = 0;
		const run: AsyncTmuxRunner = async args => {
			await fake.run(args);
			if (
				args.includes('kill-session') &&
				args.some(arg => arg.startsWith('=companion-'))
			)
				throw new Error('companion kill failed');
			return '';
		};
		t.false(await killSpaceSessions('TEST-KEEP', {run}));
		t.false(
			fake.calls.some(
				args =>
					args.includes('kill-session') &&
					args.some(arg => /^=(?:agent|claude)-/.test(arg)),
			),
		);
		await attachToSpace('%1', '%2', 'TEST-KEEP', '%0', undefined, undefined, {
			run: fake.run,
		});
		t.false(
			fake.calls.some(
				args =>
					args.includes('new-session') ||
					args.some(arg => arg.includes('claude --resume')),
			),
		);
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
		t.false(fake.calls.some(args => isSwitchBatch(args)));
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
		t.true(targets.every(target => target!.endsWith('-TEST-C:')));
		t.false(fake.calls.some(args => args.some(arg => arg.includes('-TEST-B'))));
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
			['has-session', 'new-session'],
		);
		t.true(
			calls.every(args => args[0] === '-L' && args[1] === 'pappardelle_inner'),
		);
		t.true(calls[1]!.includes('PAPPARDELLE_SPACE=TEST-NEW'));
		t.true(calls[1]!.includes('custom-ui'));
		// An agent started by hand in the companion isn't the space's agent.
		t.false(
			calls[1]!.some(arg => arg.startsWith('PAPPARDELLE_AGENT_PROFILE=')),
		);
	},
);

// The agent's hook records its session id under these (hooks/agent_session.py).
test.serial(
	'a new agent session tells the hook its agent profile, its kind and the agent-sessions file',
	async t => {
		const calls: string[][] = [];
		const run: AsyncTmuxRunner = async args => {
			calls.push(args);
			if (args.includes('has-session')) throw new Error('no session');
			return '';
		};
		t.true(
			await ensureAgentSession('TEST-NEW', '/tmp', false, run, {
				name: 'codex',
				command: 'codex',
				args: '',
				isClaude: false,
				model: '',
				effort: '',
			}),
		);
		const created = calls.find(args => args.includes('new-session'))!;
		t.true(created.includes('PAPPARDELLE_AGENT_PROFILE=codex'));
		t.true(created.includes('PAPPARDELLE_AGENT_IS_CLAUDE=false'));
		t.true(
			created.some(
				arg =>
					arg.startsWith('PAPPARDELLE_AGENT_SESSIONS=') &&
					arg.endsWith('/space-state/TEST-NEW.agent-sessions.json'),
			),
		);
	},
);
