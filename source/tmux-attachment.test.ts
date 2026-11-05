import {spawnSync} from 'node:child_process';
import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'ava';
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

// The shell script a viewer's frame host runs, unwrapped from the
// respawn-pane command line.
function frameScript(command: string): string {
	const words = spawnSync(
		'/bin/sh',
		['-c', `for word in ${command}; do printf '%s\\0' "$word"; done`],
		{encoding: 'utf8'},
	).stdout.split('\0');
	return words[words.indexOf('-c') + 1]!;
}

// One tmux invocation's `;`-separated commands.
function splitBatch(args: string[]): string[][] {
	const commands: string[][] = [[]];
	for (const arg of args) {
		if (arg === ';') commands.push([]);
		else commands.at(-1)!.push(arg);
	}
	return commands;
}

const isSwitchBatch = (args: string[]) =>
	args.includes('switch-client') && args.includes(';');

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

test.beforeEach(() => {
	clearCurrentlyViewingSpace();
});

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
				.map(args => frameScript(args.at(-1)!));
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
		t.deepEqual(batch.slice(0, 2), ['-L', 'pappardelle_inner']);
		const commands = splitBatch(batch.slice(2));
		const target = (prefix: string) =>
			commands.find(
				command =>
					command[0] === 'switch-client' &&
					command[4]!.startsWith(`=${prefix}-`),
			);
		t.deepEqual(target('agent')?.slice(0, 4), [
			'switch-client',
			'-c',
			'/dev/claude',
			'-t',
		]);
		t.true(target('agent')![4]!.endsWith('-TEST-B:'));
		t.deepEqual(target('companion')?.slice(0, 4), [
			'switch-client',
			'-c',
			'/dev/companion',
			'-t',
		]);
		t.true(target('companion')![4]!.endsWith('-TEST-B:'));
		const titles = commands
			.filter(command => command[3] === 'set-titles-string')
			.map(command => command[4]);
		t.deepEqual(titles, ['agent · TEST-B', 'companion']);
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
