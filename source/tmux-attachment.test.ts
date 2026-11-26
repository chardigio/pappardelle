import {spawnSync} from 'node:child_process';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sessionNamesFor} from './space-identity.ts';
import {test, expect, beforeAll, afterAll, beforeEach} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {LatestTask} from './latest-task.ts';
import {
	attachToSpace,
	clearCurrentlyViewingSpace,
	getCurrentlyViewingSpace,
	ensureAgentSession,
	ensureCompanionSession,
	initTmuxState,
	killSpaceSessions,
	registerAwaitingFrame,
	type AsyncTmuxRunner,
} from './tmux.ts';
import {
	FRAME_COMMAND_OPTION,
	frameReadyChannel,
	frameStartedChannel,
} from './pane-frame-options.ts';
import {clearRecentErrors, getRecentErrors} from './logger.ts';
import {shellQuote} from './shell-quote.ts';
import {
	DEFAULT_RESOLVED_AGENT_PROFILE,
	getRepoName,
	type ResolvedAgentProfile,
} from './config.ts';
import {
	StartupTrace,
	startupTrace,
	type StartupRecord,
} from './startup-trace.ts';
import {
	testState,
	testTmuxState,
	type TestState,
} from '../test/helpers/state.ts';

// A new agent session's launch is recorded in the stores.
const stateTeardowns: Array<() => unknown> = [];
let derived: TestState;
beforeAll(() => {
	// Without the database a space's sessions get the names idow gives them.
	derived = testTmuxState({
		cleanup: fn => stateTeardowns.push(fn),
		repo: getRepoName(),
		sqlite: false,
	});
});
afterAll(async () => {
	for (const step of stateTeardowns.reverse()) await step();
});

// attachToSpace reads the .pappardelle.yml of the repository it runs in. The
// monorepo's config sets `companion_command: ""`, which starts no companion
// command, so the launch tests failed there and passed upstream (STA-3087).
// An empty repository gives every checkout the default config. A space sets
// PAPPARDELLE_MAIN_REPO_ROOT, which would point the lookup back at its repo.
const emptyRepository = mkdtempSync(join(tmpdir(), 'pappa-attach-repo-'));
spawnSync('git', ['init', '-q', emptyRepository]);
process.chdir(emptyRepository);
delete process.env['PAPPARDELLE_MAIN_REPO_ROOT'];
afterAll(() => {
	rmSync(emptyRepository, {recursive: true, force: true});
});

test('background monitor discovery does not consume the selected startup trace', async () => {
	const records: StartupRecord[] = [];
	const previous = startupTrace.current;
	startupTrace.current = new StartupTrace({
		pid: 1,
		now: () => 0,
		write: record => records.push(record),
		schedule: () => () => {},
	});
	teardown(() => {
		startupTrace.current = previous;
	});
	await testState().daos.programStatus.attach(
		'background',
		'agent-background',
		'fixture',
		async () => '',
	);
	expect(records.some(record => record.stage === 'monitor-ready')).toBe(false);
	await ensureAgentSession('TEST-SELECTED', undefined, false, async () => '');
	expect(
		records.filter(
			record => record.stage === 'monitor-ready' && record.phase === 'begin',
		).length,
	).toBe(1);
});

function fakeTmux() {
	const calls: string[][] = [];
	const run: AsyncTmuxRunner = async args => {
		calls.push(args);
		if (ttyQueryPane(args) !== undefined)
			return ttyQueryPane(args) === '%1' ? '/dev/claude' : '/dev/companion';
		if (args.includes('list-clients')) return '/dev/claude\n/dev/companion\n';
		return '';
	};
	return {calls, run};
}

// The pane whose client tty a call asks for: a plain read, or the wait for a
// frame that was just started to publish it.
function ttyQueryPane(args: string[]): string | undefined {
	const read = args.indexOf('display-message');
	return read === -1 ? undefined : args[read + 3];
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

function isolatedHome(): string {
	const home = mkdtempSync(join(tmpdir(), 'pappa-cold-attach-'));
	const previous = process.env['HOME'];
	process.env['HOME'] = home;
	teardown(() => {
		if (previous === undefined) delete process.env['HOME'];
		else process.env['HOME'] = previous;
		rmSync(home, {recursive: true, force: true});
	});
	return home;
}

for (const delayed of ['agent-gate', 'companion-create']) {
	test(`cold cancellation drains ${delayed} and delivers both launch commands before the next selection`, async () => {
		const home = isolatedHome();
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
			if (ttyQueryPane(args) !== undefined)
				return ttyQueryPane(args) === '%1' ? '/dev/agent' : '/dev/companion';
			if (args.includes('list-clients')) return '/dev/agent\n/dev/companion';
			return '';
		};
		const select = async (key: string) =>
			queue.run(async signal => {
				await attachToSpace('%1', '%2', key, '%0', home, undefined, {
					configLoad: {kind: 'missing'},
					run,
					signal,
				});
			});
		const first = select('TEST-COLD').then(() => {
			finished = true;
		});
		await nextTurn();
		expect(blocked).toBe(true);
		const next = select('TEST-NEXT');
		await nextTurn();
		expect(finished).toBe(false);
		expect(
			calls.some(args => args.some(arg => arg.includes('TEST-NEXT'))),
		).toBe(false);
		release();
		await Promise.all([first, next]);
		const creations = calls.filter(args => args.includes('new-session'));
		expect(creations.length).toBe(2);
		const agent = creations.find(args =>
			args.some(arg => arg.startsWith('agent-')),
		)!;
		const companion = creations.find(args =>
			args.some(arg => arg.startsWith('companion-')),
		)!;
		expect(agent.some(arg => arg.includes('wait-for'))).toBe(true);
		for (const creation of [agent, companion]) {
			const shell = creation.findIndex(arg => arg.includes('"$1" -ic "$2'));
			expect(shell !== -1).toBe(true);
			expect(creation[shell + 3]?.trim()).toBeTruthy();
		}
		const gate = calls.findIndex(
			args =>
				args.includes('if-shell') &&
				args.some(arg => arg.includes('TEST-COLD')),
		);
		const nextStart = calls.findIndex(args =>
			args.some(arg => arg.includes('TEST-NEXT')),
		);
		expect(gate !== -1 && gate < nextStart).toBe(true);
		expect(getCurrentlyViewingSpace()).toBe('TEST-NEXT');
	});
}

for (const delayed of ['%1', '%2']) {
	for (const cancelled of [false, true]) {
		test(`cold viewer respawn ${cancelled ? 'cancellation' : 'failure'} drains ${delayed} before recovery`, async () => {
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
				if (ttyQueryPane(args) !== undefined)
					return `/dev/${ttyQueryPane(args)}`;
				if (!recovering && args.includes('respawn-pane')) {
					const pane = args[args.indexOf('-t') + 1]!;
					started.add(pane);
					if (pane === delayed) await pending;
					else if (!cancelled) throw new Error('respawn failed');
				}
				return '';
			};
			const first = queue.run(async signal => {
				expect(
					await attachToSpace(
						'%1',
						'%2',
						'TEST-COLD',
						'%0',
						undefined,
						undefined,
						{configLoad: {kind: 'missing'}, run, signal},
					),
				).toBe(false);
				finished = true;
			});
			await nextTurn();
			expect([...started].sort()).toStrictEqual(['%1', '%2']);
			if (cancelled) queue.cancel();
			const next = queue.exclusive(async () => {
				recovering = true;
				expect(
					await attachToSpace(
						'%1',
						'%2',
						'TEST-RECOVER',
						'%0',
						undefined,
						undefined,
						{configLoad: {kind: 'missing'}, run},
					),
				).toBe(true);
			});
			await nextTurn();
			expect(finished).toBe(false);
			expect(recovering).toBe(false);
			release();
			await Promise.all([first, next]);
			expect(getCurrentlyViewingSpace()).toBe('TEST-RECOVER');
		});
	}
}
// The listing that finds a space's companion splits rides the attach's own
// tmux call.
const isSplitListing = (command: string[] | undefined) =>
	command?.[0] === 'list-sessions' && command[2]!.includes('@pappa_split');

const isSwitchBatch = (args: string[]) =>
	args.includes('switch-client') && args.includes(';');

for (const delayed of ['agent', 'companion']) {
	test(`superseding selection waits for pending ${delayed} preparation`, async () => {
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
					configLoad: {kind: 'missing'},
					run,
					signal,
				});
			});
		const first = select('TEST-A').then(() => {
			firstFinished = true;
		});
		await nextTurn();
		expect([...started].sort()).toStrictEqual(['agent', 'companion']);
		const second = select('TEST-B');
		await nextTurn();
		expect(firstFinished).toBe(false);
		expect(getCurrentlyViewingSpace()).toBe(null);
		expect(
			fake.calls.some(args => args.some(arg => arg.includes('TEST-B'))),
		).toBe(false);
		release();
		await Promise.all([first, second]);
		expect(getCurrentlyViewingSpace()).toBe('TEST-B');
		expect(
			fake.calls.some(
				args =>
					args.includes('switch-client') &&
					args.some(arg => arg.endsWith('-TEST-A:')),
			),
		).toBe(false);
	});
}

const titleAndFocus = (issueKey: string, agentName = 'claude') => [
	'set-option',
	'-p',
	'-t',
	'%1',
	'@pappardelle_title',
	`${agentName} · ${issueKey}`,
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
	test(`${cancel ? 'cancelled' : 'failed'} viewer waits for sibling on ${delayed} before allowing retry`, async () => {
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
			{configLoad: {kind: 'missing'}, run, signal: controller.signal},
		).then(result => {
			finished = true;
			return result;
		});
		await nextTurn();
		expect(started.size).toBe(2);
		if (cancel) controller.abort();
		expect(finished).toBe(false);
		expect(getCurrentlyViewingSpace()).toBe(null);
		release();
		expect(await attaching).toBe(false);
		expect(fake.calls.some(args => args.includes('@pappardelle_title'))).toBe(
			false,
		);
		fake.calls.length = 0;
		expect(
			await attachToSpace(
				'%1',
				'%2',
				'TEST-RECOVER',
				'%0',
				undefined,
				undefined,
				{configLoad: {kind: 'missing'}, run: fake.run},
			),
		).toBe(true);
		expect(fake.calls.some(args => isSwitchBatch(args))).toBe(false);
		expect(getCurrentlyViewingSpace()).toBe('TEST-RECOVER');
	});
}

beforeEach(() => {
	clearCurrentlyViewingSpace();
});

test('failed cold respawn discards cached ttys before a recycled pty can target the other viewer', async () => {
	let phase = 'empty';
	const ttys = new Map([
		['%1', '/dev/old-agent'],
		['%2', '/dev/old-companion'],
	]);
	const destinations = new Map<string, string>();
	const run: AsyncTmuxRunner = async args => {
		if (args.includes('has-session') && phase === 'empty')
			throw new Error('no session');
		if (ttyQueryPane(args) !== undefined) {
			const pane = ttyQueryPane(args)!;
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
		attachToSpace('%1', '%2', key, '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run,
		});
	expect(await attach('TEST-EMPTY')).toBe(true);
	phase = 'failed';
	expect(await attach('TEST-FAILED')).toBe(false);
	phase = 'retry';
	expect(await attach('TEST-RETRY')).toBe(true);
	expect(destinations.get('%1')?.startsWith('=agent-')).toBe(true);
	expect(destinations.get('%2')?.startsWith('=companion-')).toBe(true);
	expect(
		[...destinations.values()].every(value => value.endsWith('-TEST-RETRY:')),
	).toBe(true);
});

for (const selected of ['qa-custom', "/tmp/socket with ' quotes"]) {
	test(`cold viewers attach to the selected socket ${selected}`, async () => {
		const previous = process.env['PAPPARDELLE_TMUX_SOCKET'];
		process.env['PAPPARDELLE_TMUX_SOCKET'] = selected;
		teardown(() => {
			if (previous === undefined) delete process.env['PAPPARDELLE_TMUX_SOCKET'];
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
		expect(
			await attachToSpace(
				'%1',
				'%2',
				'TEST-SOCKET',
				'%0',
				undefined,
				undefined,
				{configLoad: {kind: 'missing'}, run},
			),
		).toBe(true);
		const commands = fake.calls
			.filter(args => args.includes('respawn-pane'))
			.map(args => frameScript(args.at(-1)!));
		expect(commands.length).toBe(2);
		for (const command of commands) {
			expect(
				command.includes(
					`${shellQuote(selected.startsWith('/') ? '-S' : '-L')} ${shellQuote(selected)}`,
				),
			).toBe(true);
			expect(command.includes('TMUX=')).toBe(false);
			expect(command.includes('TEST-SOCKET:')).toBe(true);
		}
	});
}

test('switching yields to input and sends both clients to the selected inner sessions', async () => {
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
		{configLoad: {kind: 'missing'}, run},
	).then(result => {
		finished = true;
		return result;
	});
	await nextTurn();
	expect(finished).toBe(false);
	release();
	expect(await attaching).toBe(true);
	const switches = fake.calls.filter(args => args.includes('switch-client'));
	expect(switches.length).toBe(2);
	expect(
		switches.every(args => args[0] === '-L' && args[1] === 'pappardelle_inner'),
	).toBe(true);
	expect(switches[0]!.at(-1)!.endsWith('-TEST-1:')).toBe(true);
	expect(switches[1]!.at(-1)!.endsWith('-TEST-1:')).toBe(true);
	expect(fake.calls.at(-1)).toStrictEqual(titleAndFocus('TEST-1'));
});

test('a superseded partial switch can return to the previously viewed space', async () => {
	const fake = fakeTmux();
	expect(
		await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run: fake.run,
		}),
	).toBe(true);
	fake.calls.length = 0;
	const controller = new AbortController();
	const run: AsyncTmuxRunner = async args => {
		const output = await fake.run(args);
		if (args.includes('switch-client')) controller.abort();
		return output;
	};
	expect(
		await attachToSpace('%1', '%2', 'TEST-B', '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run,
			signal: controller.signal,
		}),
	).toBe(false);
	expect(getCurrentlyViewingSpace()).toBe(null);
	expect(fake.calls.filter(args => args.includes('switch-client')).length).toBe(
		1,
	);
	fake.calls.length = 0;
	expect(
		await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run: fake.run,
		}),
	).toBe(true);
	expect(fake.calls.map(args => args.includes('switch-client'))).toStrictEqual([
		true,
		false,
	]);
	expect(fake.calls[0]!.includes(';')).toBe(true);
	expect(getCurrentlyViewingSpace()).toBe('TEST-A');
});

test('a label titles the agent frame in place of the key', async () => {
	const fake = fakeTmux();
	await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
		configLoad: {kind: 'missing'},
		run: fake.run,
	});
	fake.calls.length = 0;
	expect(
		await attachToSpace('%1', '%2', 'main', '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run: fake.run,
			label: 'sous-chef',
		}),
	).toBe(true);
	const titles = splitBatch(fake.calls[0]!.slice(2))
		.filter(command => command[3] === 'set-titles-string')
		.map(command => command[4]);
	expect(titles).toStrictEqual(['claude · sous-chef', 'companion']);
	expect(fake.calls[1]).toStrictEqual(titleAndFocus('sous-chef'));
});

test('warm switches move both viewers in one request without setup probes', async () => {
	const fake = fakeTmux();
	await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
		configLoad: {kind: 'missing'},
		run: fake.run,
	});
	fake.calls.length = 0;
	expect(
		await attachToSpace('%1', '%2', 'TEST-WARM-B', '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run: fake.run,
		}),
	).toBe(true);
	expect(fake.calls.length).toBe(2);
	const batch = fake.calls[0]!;
	expect(batch.slice(0, 2)).toStrictEqual(['-L', 'pappardelle_inner']);
	const commands = splitBatch(batch.slice(2));
	expect(isSplitListing(commands.at(-1))).toBe(true);
	const target = (prefix: string) =>
		commands.find(
			command =>
				command[0] === 'switch-client' && command[4]!.startsWith(`=${prefix}-`),
		);
	expect(target('agent')?.slice(0, 4)).toStrictEqual([
		'switch-client',
		'-c',
		'/dev/claude',
		'-t',
	]);
	expect(target('agent')![4]!.endsWith('-TEST-WARM-B:')).toBe(true);
	expect(target('companion')?.slice(0, 4)).toStrictEqual([
		'switch-client',
		'-c',
		'/dev/companion',
		'-t',
	]);
	expect(target('companion')![4]!.endsWith('-TEST-WARM-B:')).toBe(true);
	const titles = commands
		.filter(command => command[3] === 'set-titles-string')
		.map(command => command[4]);
	expect(titles).toStrictEqual(['claude · TEST-WARM-B', 'companion']);
	expect(fake.calls[1]).toStrictEqual(titleAndFocus('TEST-WARM-B'));
});

test('a switch and a session start use the names stored for the space', async () => {
	const stored = testState({repo: getRepoName(), sqlite: true});
	for (const key of ['TEST-A', 'TEST-HAND']) {
		// eslint-disable-next-line no-await-in-loop -- One store, written in turn.
		await stored.daos.spaceIdentities.record({
			repo: getRepoName(),
			key,
			worktreePath: '/tmp',
			tmux: {
				socket: 'pappardelle_inner',
				agentSession: `hand-named-agent-${key}`,
				companionSession: `hand-named-companion-${key}`,
			},
		});
	}

	initTmuxState(stored.daos);
	teardown(() => {
		initTmuxState(derived.daos);
	});
	const fake = fakeTmux();
	await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
		configLoad: {kind: 'missing'},
		run: fake.run,
	});
	fake.calls.length = 0;
	expect(
		await attachToSpace('%1', '%2', 'TEST-HAND', '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run: fake.run,
		}),
	).toBe(true);
	expect(
		splitBatch(fake.calls[0]!.slice(2))
			.filter(command => command[0] === 'switch-client')
			.map(command => command[4]),
	).toStrictEqual([
		'=hand-named-agent-TEST-HAND:',
		'=hand-named-companion-TEST-HAND:',
	]);

	const started: string[][] = [];
	const run: AsyncTmuxRunner = async args => {
		started.push(args);
		if (args.includes('has-session')) throw new Error('no session');
		return '';
	};
	expect(await ensureCompanionSession('TEST-HAND', '/tmp', '', run)).toBe(true);
	expect(await ensureAgentSession('TEST-HAND', '/tmp', false, run)).toBe(true);
	expect(
		started
			.filter(args => args.includes('new-session'))
			.map(args => args[args.indexOf('-s') + 1]),
	).toStrictEqual([
		'hand-named-companion-TEST-HAND',
		'hand-named-agent-TEST-HAND',
	]);
});

test("a warm switch finds the space's splits in its own request's listing", async () => {
	const fake = fakeTmux();
	await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
		configLoad: {kind: 'missing'},
		run: fake.run,
	});
	fake.calls.length = 0;
	const run: AsyncTmuxRunner = async args => {
		const output = await fake.run(args);
		if (!isSwitchBatch(args)) return output;
		const companion = args
			.find(arg => arg.startsWith('=companion-'))!
			.slice(1, -1);
		return [
			`${companion}\t\t\t\t%8\tsh\t80\t24\t1\t1\t`,
			`${companion}~logs\tdown\t\t1\t%9\tsh\t80\t24\t0\t\t`,
		].join('\n');
	};

	expect(
		await attachToSpace('%1', '%2', 'TEST-B', '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run,
		}),
	).toBe(true);
	// The split it found sends it on to measure the window.
	expect(fake.calls[2]?.slice(0, 3)).toStrictEqual(['list-panes', '-t', '%1']);
	expect(fake.calls.some(args => args[2] === 'list-sessions')).toBe(false);
});

test('an invalid warm cache falls back and retries both viewers after a partial batch', async () => {
	const fake = fakeTmux();
	await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
		configLoad: {kind: 'missing'},
		run: fake.run,
	});
	fake.calls.length = 0;
	const run: AsyncTmuxRunner = async args => {
		const output = await fake.run(args);
		if (isSwitchBatch(args)) throw new Error('second client disappeared');
		if (ttyQueryPane(args) !== undefined) {
			return ttyQueryPane(args) === '%1'
				? '/dev/new-claude'
				: '/dev/new-companion';
		}
		if (args.includes('list-clients')) {
			return '/dev/new-claude\n/dev/new-companion\n';
		}
		return output;
	};
	clearRecentErrors();
	expect(
		await attachToSpace('%1', '%2', 'TEST-B', '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run,
		}),
	).toBe(true);
	const retries = fake.calls.filter(
		args => args.includes('switch-client') && !args.includes(';'),
	);
	expect(retries.length).toBe(2);
	expect(retries.map(args => args[4])).toStrictEqual([
		'/dev/new-claude',
		'/dev/new-companion',
	]);
	expect(retries.every(args => args.at(-1)!.endsWith('-TEST-B:'))).toBe(true);
	expect(getCurrentlyViewingSpace()).toBe('TEST-B');
	expect(
		getRecentErrors().some(error =>
			error.message.includes('Fast workspace switch to TEST-B failed'),
		),
	).toBe(true);
});

test('a first switch to a workspace without sessions falls back without reporting an error', async () => {
	const fake = fakeTmux();
	await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
		configLoad: {kind: 'missing'},
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
	expect(
		await attachToSpace('%1', '%2', 'TEST-B', '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run,
		}),
	).toBe(true);
	expect(getCurrentlyViewingSpace()).toBe('TEST-B');
	expect(getRecentErrors()).toStrictEqual([]);
});

test('a switch whose viewer client left with its ended session falls back without reporting an error', async () => {
	const fake = fakeTmux();
	await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
		configLoad: {kind: 'missing'},
		run: fake.run,
	});
	const run: AsyncTmuxRunner = async args => {
		const output = await fake.run(args);
		if (isSwitchBatch(args)) {
			throw Object.assign(new Error('Command failed'), {
				code: 1,
				stderr: "can't find client: /dev/pts/9\n",
			});
		}

		return output;
	};
	clearRecentErrors();
	expect(
		await attachToSpace('%1', '%2', 'TEST-B', '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run,
		}),
	).toBe(true);
	expect(getRecentErrors()).toStrictEqual([]);
});

test('a missing companion session says the companion, not the agent, is not running', async () => {
	const fake = fakeTmux();
	const {companion} = sessionNamesFor('TEST-C', getRepoName());
	const run: AsyncTmuxRunner = async args => {
		if (
			(args.includes('has-session') || args.includes('new-session')) &&
			args.some(arg => arg.includes(companion))
		)
			throw Object.assign(new Error('companion failed'), {code: 1});
		return fake.run(args);
	};
	clearCurrentlyViewingSpace();
	await attachToSpace('%1', '%2', 'TEST-C', '%0', '/tmp', undefined, {
		configLoad: {kind: 'missing'},
		run,
	});
	const respawned = (paneId: string) =>
		fake.calls
			.filter(args => args.includes('respawn-pane') && args.includes(paneId))
			.flat()
			.join(' ');
	expect(respawned('%2').includes('has no companion running')).toBe(true);
	expect(
		fake.calls.flat().some(arg => arg.includes('has no agent running')),
	).toBe(false);
	clearCurrentlyViewingSpace();
});

test('an absent inner server displays no-session state without hiding real client-query errors', async () => {
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
		{configLoad: {kind: 'missing'}, run},
	);
	expect(
		fake.calls.some(args =>
			args.some(
				arg =>
					arg.includes('has no agent running') &&
					arg.includes('ABSENT-FIXTURE-999999'),
			),
		),
	).toBe(true);
	expect(
		getRecentErrors().some(error => error.message.includes('Failed to attach')),
	).toBe(false);
	clearCurrentlyViewingSpace();
	const denied: AsyncTmuxRunner = async args => {
		if (args.includes('list-clients'))
			throw Object.assign(new Error('permission denied'), {
				code: 1,
				stderr: 'Permission denied',
			});
		return fake.run(args);
	};
	expect(
		await attachToSpace('%1', '', 'TEST-DENIED', '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run: denied,
		}),
	).toBe(false);
	expect(
		getRecentErrors().some(error => error.message.includes('Failed to attach')),
	).toBe(true);
});

test('companion teardown failure leaves Claude alive and reattachment sends no launch command', async () => {
	const fake = fakeTmux();
	await attachToSpace('%1', '%2', 'TEST-KEEP', '%0', undefined, undefined, {
		configLoad: {kind: 'missing'},
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
	expect(await killSpaceSessions('TEST-KEEP', {run})).toBe(false);
	expect(
		fake.calls.some(
			args =>
				args.includes('kill-session') &&
				args.some(arg => /^=(?:agent|claude)-/.test(arg)),
		),
	).toBe(false);
	await attachToSpace('%1', '%2', 'TEST-KEEP', '%0', undefined, undefined, {
		configLoad: {kind: 'missing'},
		run: fake.run,
	});
	expect(
		fake.calls.some(
			args =>
				args.includes('new-session') ||
				args.some(arg => arg.includes('claude --resume')),
		),
	).toBe(false);
});

test('replaced viewer panes invalidate TTYs even for the same selected workspace', async () => {
	const fake = fakeTmux();
	await attachToSpace('%1', '%2', 'TEST-A', '%0', undefined, undefined, {
		configLoad: {kind: 'missing'},
		run: fake.run,
	});
	fake.calls.length = 0;
	expect(
		await attachToSpace('%3', '', 'TEST-A', '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run: fake.run,
		}),
	).toBe(true);
	expect(fake.calls.some(args => ttyQueryPane(args) === '%3')).toBe(true);
	expect(fake.calls.some(args => isSwitchBatch(args))).toBe(false);
});

test('rapid navigation skips stale selections while tmux is still responding', async () => {
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
				configLoad: {kind: 'missing'},
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
	expect(targets.length).toBe(2);
	expect(targets.every(target => target!.endsWith('-TEST-C:'))).toBe(true);
	expect(
		fake.calls.some(args => args.some(arg => arg.includes('-TEST-B'))),
	).toBe(false);
	expect(getCurrentlyViewingSpace()).toBe('TEST-C');
});

test('a failed tmux switch is reported as failure and can be retried', async () => {
	const fake = fakeTmux();
	const run: AsyncTmuxRunner = async args => {
		if (args.includes('switch-client')) throw new Error('client disappeared');
		return fake.run(args);
	};
	expect(
		await attachToSpace('%1', '%2', 'TEST-FAIL', '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run,
		}),
	).toBe(false);
	expect(getCurrentlyViewingSpace()).toBe(null);
	expect(
		await attachToSpace('%1', '%2', 'TEST-FAIL', '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run: fake.run,
		}),
	).toBe(true);
});

test('cold companion creation completes its command before reporting success', async () => {
	const calls: string[][] = [];
	const run: AsyncTmuxRunner = async args => {
		calls.push(args);
		if (args.includes('has-session')) throw new Error('no session');
		return '';
	};
	expect(
		await ensureCompanionSession('TEST-NEW', '/tmp', 'custom-ui', run),
	).toBe(true);
	expect(calls.map(args => args[2])).toStrictEqual([
		'has-session',
		'new-session',
		'set-option',
	]);
	expect(calls[2]!.slice(3)).toStrictEqual([
		'-p',
		'-t',
		`=${calls[1]![calls[1]!.indexOf('-s') + 1]}:`,
		'@pappa_pane',
		'main',
	]);
	expect(
		calls.every(args => args[0] === '-L' && args[1] === 'pappardelle_inner'),
	).toBe(true);
	expect(calls[1]!.includes('PAPPARDELLE_SPACE=TEST-NEW')).toBe(true);
	expect(calls[1]!.includes('custom-ui')).toBe(true);
});

const CODEX_PROFILE: ResolvedAgentProfile = {
	...DEFAULT_RESOLVED_AGENT_PROFILE,
	name: 'codex',
	command: 'codex',
	isClaude: false,
};

// The agent's hook records its session id under the stored agent profile
// (plugins/pappardelle/hooks/agent_session.py), never one the session carries.
test('a new agent session stores the agent profile it was started with', async () => {
	const calls: string[][] = [];
	const run: AsyncTmuxRunner = async args => {
		calls.push(args);
		if (args.includes('has-session')) throw new Error('no session');
		return '';
	};
	expect(
		await ensureAgentSession('TEST-NEW', '/tmp', false, run, CODEX_PROFILE),
	).toBe(true);
	expect(derived.daos.spaceState.read('TEST-NEW')?.agentProfile).toStrictEqual({
		name: 'codex',
		isClaude: false,
	});
	const created = calls.find(args => args.includes('new-session'))!;
	expect(created.some(arg => arg.startsWith('PAPPARDELLE_AGENT_'))).toBe(false);
});

test('a new agent session starts when its agent profile cannot be stored', async () => {
	const {spaceState} = derived.daos;
	const {write} = spaceState;
	spaceState.write = async () => {
		throw new Error('database is locked');
	};
	teardown(() => {
		spaceState.write = write;
	});
	const calls: string[][] = [];
	const run: AsyncTmuxRunner = async args => {
		calls.push(args);
		if (args.includes('has-session')) throw new Error('no session');
		return '';
	};
	expect(
		await ensureAgentSession('TEST-NEW', '/tmp', false, run, CODEX_PROFILE),
	).toBe(true);
	expect(calls.some(args => args.includes('new-session'))).toBe(true);
});

test("a new agent session carries its agent profile's env, one -e per variable", async () => {
	const calls: string[][] = [];
	const run: AsyncTmuxRunner = async args => {
		calls.push(args);
		if (args.includes('has-session')) throw new Error('no session');
		return '';
	};
	await ensureAgentSession('TEST-ENV', '/tmp', false, run, {
		...DEFAULT_RESOLVED_AGENT_PROFILE,
		name: 'opus',
		env: {CODE_MODE: '1', SPACED: "a b'c", PI_PROGRAM_STATUS: '0'},
	});
	const created = calls.find(args => args.includes('new-session'))!;
	const envFlags = created.flatMap((arg, i) =>
		arg === '-e' ? [created[i + 1]!] : [],
	);
	expect(envFlags.includes('CODE_MODE=1')).toBe(true);
	expect(envFlags.includes("SPACED=a b'c")).toBe(true);
	// tmux keeps the last -e for a name, so pappardelle's own value wins.
	expect(envFlags.findLast(flag => flag.startsWith('PI_PROGRAM_STATUS='))).toBe(
		'PI_PROGRAM_STATUS=1',
	);
});

test('a frame started with its pane is handed its program, and a later start respawns it', async () => {
	registerAwaitingFrame('%7');
	const calls: string[][] = [];
	let clientGone = false;
	const run: AsyncTmuxRunner = async args => {
		calls.push(args);
		if (clientGone && isSwitchBatch(args)) throw new Error('client gone');
		return ttyQueryPane(args) === undefined ? '' : '/dev/frame';
	};
	const attach = async (key: string) =>
		attachToSpace('%7', '', key, '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run,
		});

	expect(await attach('TEST-WARM')).toBe(true);
	const handed = calls.find(args => args.includes(FRAME_COMMAND_OPTION))!;
	const program = handed[handed.indexOf(FRAME_COMMAND_OPTION) + 1]!;
	expect(
		program.includes(`=${sessionNamesFor('TEST-WARM', getRepoName()).agent}:`),
	).toBe(true);
	expect(program.includes('claude · TEST-WARM')).toBe(true);
	expect(handed.slice(-3)).toStrictEqual([
		'wait-for',
		'-S',
		frameReadyChannel('%7'),
	]);
	expect(calls.some(args => args.includes('respawn-pane'))).toBe(false);

	calls.length = 0;
	clientGone = true;
	expect(await attach('TEST-NEXT')).toBe(true);
	expect(calls.some(args => args.includes('respawn-pane'))).toBe(true);
	expect(calls.some(args => args.includes(FRAME_COMMAND_OPTION))).toBe(false);
});

test('a started signal left by an earlier start does not stand in for the new frame', async () => {
	const calls: string[][] = [];
	let waits = 0;
	const run: AsyncTmuxRunner = async args => {
		calls.push(args);
		if (args[0] === 'wait-for') return ++waits === 1 ? '' : '/dev/late';
		return '';
	};
	const attach = async (key: string) =>
		attachToSpace('%8', '', key, '%0', undefined, undefined, {
			configLoad: {kind: 'missing'},
			run,
		});

	expect(await attach('TEST-STALE')).toBe(true);
	expect(waits).toBe(2);
	expect(
		calls
			.filter(args => args[0] === 'wait-for')
			.every(args => args[1] === frameStartedChannel('%8')),
	).toBe(true);
	calls.length = 0;
	expect(await attach('TEST-AFTER')).toBe(true);
	const switched = calls.find(args => isSwitchBatch(args))!;
	expect(switched[switched.indexOf('-c') + 1]).toBe('/dev/late');
});

// A config that fails validation while the TUI runs must not bring a space's
// programs back with built-in commands: its agent profile, model and env would
// be lost.
const INVALID_AGENT_PROFILE =
	'agent_profiles:\n  opus:\n    command: claude\n    model: 7\n';
const VALID_CONFIG = 'version: 1\nprofiles: {}\n';
const projectConfig = () => join(emptyRepository, '.pappardelle.yml');

function withInvalidConfig(): void {
	isolatedHome();
	writeFileSync(projectConfig(), INVALID_AGENT_PROFILE);
	teardown(() => {
		rmSync(projectConfig(), {force: true});
	});
}

function tmuxMissingSessions(...missing: string[]) {
	const fake = fakeTmux();
	const run: AsyncTmuxRunner = async args => {
		if (
			args.includes('has-session') &&
			args.some(arg => missing.some(session => arg.includes(session)))
		)
			throw Object.assign(new Error('no session'), {code: 1});
		return fake.run(args);
	};
	return {calls: fake.calls, run};
}

const createsSession = (calls: string[][], session: string) =>
	calls.some(
		args =>
			args.includes('new-session') && args.some(arg => arg.includes(session)),
	);

const showsNoProgram = (
	calls: string[][],
	issueKey: string,
	program: 'agent' | 'companion',
) =>
	calls.some(args =>
		args.some(
			arg =>
				arg.includes(`has no ${program} running`) && arg.includes(issueKey),
		),
	);

const configStateLines = () =>
	getRecentErrors().filter(error =>
		error.message.startsWith('.pappardelle.yml is invalid:'),
	);

const invalidConfigErrors = (issueKey: string) =>
	getRecentErrors().filter(error =>
		error.message.startsWith(`Sessions of ${issueKey} not started`),
	);

test('an invalid config holds back dead sessions and says why, once', async () => {
	withInvalidConfig();
	const {agent, companion} = sessionNamesFor('TEST-INVALID', getRepoName());
	const {calls, run} = tmuxMissingSessions(agent, companion);
	clearRecentErrors();
	clearCurrentlyViewingSpace();
	await attachToSpace('%1', '%2', 'TEST-INVALID', '%0', '/tmp', undefined, {
		configLoad: {kind: 'missing'},
		run,
	});
	expect(createsSession(calls, agent)).toBe(false);
	expect(createsSession(calls, companion)).toBe(false);
	expect(showsNoProgram(calls, 'TEST-INVALID', 'agent')).toBe(true);
	expect(showsNoProgram(calls, 'TEST-INVALID', 'companion')).toBe(true);
	const [reported, ...more] = invalidConfigErrors('TEST-INVALID');
	expect(more).toStrictEqual([]);
	expect(reported?.message).toBe(
		'Sessions of TEST-INVALID not started: the config is invalid',
	);
	expect(
		configStateLines()[0]?.message.includes('agent_profiles.opus.model'),
	).toBe(true);
	expect(derived.daos.spaceState.read('TEST-INVALID')?.agentProfile).toBe(
		undefined,
	);

	clearCurrentlyViewingSpace();
	await attachToSpace('%1', '%2', 'TEST-INVALID', '%0', '/tmp', undefined, {
		configLoad: {kind: 'missing'},
		run,
	});
	expect(invalidConfigErrors('TEST-INVALID').length).toBe(1);
	clearCurrentlyViewingSpace();
});

const agentFrameTitles = (calls: string[][]) =>
	calls
		.filter(args => args.includes('@pappardelle_title') && args.includes('%1'))
		.map(args => args[args.indexOf('@pappardelle_title') + 1]);

test('an invalid config titles a cold agent frame agent, whatever name the caller has', async () => {
	withInvalidConfig();
	const {agent, companion} = sessionNamesFor(
		'TEST-INVALID-NAME',
		getRepoName(),
	);
	const {calls, run} = tmuxMissingSessions(agent, companion);
	clearCurrentlyViewingSpace();
	await attachToSpace(
		'%1',
		'%2',
		'TEST-INVALID-NAME',
		'%0',
		'/tmp',
		undefined,
		{
			configLoad: {kind: 'missing'},
			run,
		},
	);
	expect(agentFrameTitles(calls)).toStrictEqual(['agent · TEST-INVALID-NAME']);
});

test('a recreated agent session is titled with the configured agent it was started with, not the stored one', async () => {
	isolatedHome();
	writeFileSync(
		projectConfig(),
		'version: 1\nprofiles: {}\nagent_profiles:\n  codex:\n    command: codex\n',
	);
	teardown(() => {
		rmSync(projectConfig(), {force: true});
	});
	await derived.daos.spaceState.write('TEST-RELAUNCH', {
		agentProfile: {name: 'codex', isClaude: false},
	});
	const {agent} = sessionNamesFor('TEST-RELAUNCH', getRepoName());
	const {calls, run} = tmuxMissingSessions(agent);
	clearCurrentlyViewingSpace();
	await attachToSpace('%1', '%2', 'TEST-RELAUNCH', '%0', '/tmp', undefined, {
		configLoad: {kind: 'missing'},
		run,
	});
	expect(createsSession(calls, agent)).toBe(true);
	expect(agentFrameTitles(calls)).toStrictEqual(['claude · TEST-RELAUNCH']);
});

test('a fast switch names the agent from the newest config read and the space as stored now', async () => {
	isolatedHome();
	writeFileSync(
		projectConfig(),
		'version: 1\nprofiles: {}\nagent_profile: codex\nagent_profiles:\n  codex:\n    command: codex\n',
	);
	teardown(() => {
		rmSync(projectConfig(), {force: true});
	});
	const {agent, companion} = sessionNamesFor('TEST-SLOW-NAME', getRepoName());
	const cold = tmuxMissingSessions(agent, companion);
	clearCurrentlyViewingSpace();
	await attachToSpace('%1', '%2', 'TEST-SLOW-NAME', '%0', '/tmp', undefined, {
		configLoad: {kind: 'invalid', errors: []},
		run: cold.run,
	});
	expect(agentFrameTitles(cold.calls)).toStrictEqual([
		'codex · TEST-SLOW-NAME',
	]);
	const fake = fakeTmux();
	const fastSwitch = async (issueKey: string) => {
		fake.calls.length = 0;
		await attachToSpace('%1', '%2', issueKey, '%0', undefined, undefined, {
			configLoad: {kind: 'invalid', errors: []},
			run: fake.run,
		});
		expect(fake.calls.some(args => args.includes('switch-client'))).toBe(true);
		return agentFrameTitles(fake.calls);
	};

	expect(await fastSwitch('TEST-FAST-NAME')).toStrictEqual([
		'codex · TEST-FAST-NAME',
	]);
	await derived.daos.spaceState.write('TEST-SLOW-NAME', {
		agentProfile: {name: 'claude', isClaude: true},
	});
	expect(await fastSwitch('TEST-SLOW-NAME')).toStrictEqual([
		'claude · TEST-SLOW-NAME',
	]);
});

test('an invalid config reports again once the rail has dropped the error', async () => {
	withInvalidConfig();
	const {agent, companion} = sessionNamesFor('TEST-AGAIN', getRepoName());
	const {run} = tmuxMissingSessions(agent, companion);
	clearRecentErrors();
	clearCurrentlyViewingSpace();
	await attachToSpace('%1', '%2', 'TEST-AGAIN', '%0', '/tmp', undefined, {
		configLoad: {kind: 'missing'},
		run,
	});
	clearRecentErrors();
	clearCurrentlyViewingSpace();
	await attachToSpace('%1', '%2', 'TEST-AGAIN', '%0', '/tmp', undefined, {
		configLoad: {kind: 'missing'},
		run,
	});
	expect(invalidConfigErrors('TEST-AGAIN').length).toBe(1);
	clearCurrentlyViewingSpace();
});

test('an invalid config still attaches sessions that are running', async () => {
	withInvalidConfig();
	const {agent, companion} = sessionNamesFor('TEST-LIVE', getRepoName());
	const {calls, run} = tmuxMissingSessions();
	clearRecentErrors();
	clearCurrentlyViewingSpace();
	await attachToSpace('%1', '%2', 'TEST-LIVE', '%0', '/tmp', undefined, {
		configLoad: {kind: 'missing'},
		run,
	});
	expect(createsSession(calls, agent)).toBe(false);
	expect(createsSession(calls, companion)).toBe(false);
	expect(showsNoProgram(calls, 'TEST-LIVE', 'agent')).toBe(false);
	expect(invalidConfigErrors('TEST-LIVE')).toStrictEqual([]);
	clearCurrentlyViewingSpace();
});

for (const [recovery, recover] of [
	['fixed', () => writeFileSync(projectConfig(), VALID_CONFIG)],
	['removed', () => rmSync(projectConfig())],
] as const) {
	test(`a ${recovery} config starts the held-back sessions and clears the error`, async () => {
		withInvalidConfig();
		const {agent, companion} = sessionNamesFor('TEST-FIXED', getRepoName());
		const {calls, run} = tmuxMissingSessions(agent, companion);
		clearRecentErrors();
		clearCurrentlyViewingSpace();
		await attachToSpace('%1', '%2', 'TEST-FIXED', '%0', '/tmp', undefined, {
			configLoad: {kind: 'missing'},
			run,
		});
		expect(invalidConfigErrors('TEST-FIXED').length).toBe(1);

		recover();
		clearCurrentlyViewingSpace();
		await attachToSpace('%1', '%2', 'TEST-FIXED', '%0', '/tmp', undefined, {
			configLoad: {kind: 'missing'},
			run,
		});
		expect(createsSession(calls, agent)).toBe(true);
		expect(createsSession(calls, companion)).toBe(true);
		expect(invalidConfigErrors('TEST-FIXED')).toStrictEqual([]);
		expect(configStateLines()).toStrictEqual([]);
		clearCurrentlyViewingSpace();
	});
}

test('an invalid config explains a held-back companion whose agent is running', async () => {
	withInvalidConfig();
	const {companion} = sessionNamesFor('TEST-COMPANION', getRepoName());
	const {calls, run} = tmuxMissingSessions(companion);
	clearRecentErrors();
	clearCurrentlyViewingSpace();
	await attachToSpace('%1', '%2', 'TEST-COMPANION', '%0', '/tmp', undefined, {
		configLoad: {kind: 'missing'},
		run,
	});
	expect(createsSession(calls, companion)).toBe(false);
	expect(invalidConfigErrors('TEST-COMPANION').length).toBe(1);
	clearCurrentlyViewingSpace();
});

test('a config that is still invalid in another way replaces the earlier report', async () => {
	withInvalidConfig();
	const {agent, companion} = sessionNamesFor('TEST-EDITED', getRepoName());
	const {run} = tmuxMissingSessions(agent, companion);
	clearRecentErrors();
	clearCurrentlyViewingSpace();
	await attachToSpace('%1', '%2', 'TEST-EDITED', '%0', '/tmp', undefined, {
		configLoad: {kind: 'missing'},
		run,
	});
	writeFileSync(
		projectConfig(),
		'agent_profiles:\n  opus:\n    command: claude\n    effort: 7\n',
	);
	clearCurrentlyViewingSpace();
	await attachToSpace('%1', '%2', 'TEST-EDITED', '%0', '/tmp', undefined, {
		configLoad: {kind: 'missing'},
		run,
	});
	expect(invalidConfigErrors('TEST-EDITED').length).toBe(1);
	const [stateLine, ...staleLines] = configStateLines();
	expect(staleLines).toStrictEqual([]);
	expect(stateLine?.message.includes('agent_profiles.opus.effort')).toBe(true);
	clearCurrentlyViewingSpace();
});
