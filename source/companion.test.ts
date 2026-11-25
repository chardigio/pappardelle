import {test, expect, beforeAll, afterAll} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {thrownBy} from '../test/helpers/thrown.ts';
import {
	closeCompanionPane,
	CompanionError,
	listCompanion,
	readCompanionPane,
	resizeCompanionPane,
	runInCompanion,
	sendCompanionKeys,
	companionSessionTarget,
} from './companion.ts';
import {initTmuxState, type OuterTmuxRunner} from './tmux.ts';
import {
	testState,
	testTmuxState,
	type TestState,
} from '../test/helpers/state.ts';

// tmux.ts names a space's sessions from the stores. Without the database they
// are the names idow gives a space, which is all this file needs.
const stateTeardowns: Array<() => unknown> = [];
let derived: TestState;
beforeAll(() => {
	derived = testTmuxState({
		cleanup: fn => stateTeardowns.push(fn),
		repo: 'repo',
		sqlite: false,
	});
});
afterAll(async () => {
	for (const step of stateTeardowns.reverse()) await step();
});

type Pane = {
	id: string;
	name?: string;
};

type Split = {
	name: string;
	split: string;
	order: number;
	size?: string;
	paneId: string;
	command?: string;
};

const MAIN = 'companion-repo-STA-1';

// A tmux stand-in holding a companion session's panes and its split
// sessions. It answers what the verbs ask, applies the writes, and records
// every call.
function fakeTmux(
	panes: Pane[],
	options: {sessions?: string[]; splits?: Split[]} = {},
) {
	const calls: string[][] = [];
	const splits = options.splits ?? [];
	const sessions = options.sessions ?? [MAIN];
	let next = 10;
	const sessionOf = (target: string) => target.replace(/^=|:$/g, '');
	const runner: OuterTmuxRunner = args => {
		calls.push([...args]);
		switch (args[0] ?? '') {
			case 'list-sessions': {
				if (args.at(-1) === '#{session_name}')
					return {
						status: 0,
						stdout:
							[
								...sessions,
								...splits.map(split => `${MAIN}~${split.name}`),
							].join('\n') + '\n',
					};
				return {
					status: 0,
					stdout: splits
						.map(split =>
							[
								`${MAIN}~${split.name}`,
								split.split,
								split.size ?? '',
								String(split.order),
								split.paneId,
								split.command ?? 'zsh',
								'60',
								'20',
								'1',
								'zsh',
							].join('\t'),
						)
						.join('\n'),
				};
			}

			case 'list-panes': {
				return {
					status: 0,
					stdout: panes
						.map(p =>
							[p.id, p.name ?? '', 'zsh', '80', '24', '1', 'zsh'].join('\t'),
						)
						.join('\n'),
				};
			}

			case 'display-message': {
				return {status: 0, stdout: '/work/tree\n'};
			}

			case 'capture-pane': {
				// tmux returns the history lines plus the whole visible screen.
				return {
					status: 0,
					stdout:
						Array.from({length: 30}, (_, i) => `line ${i + 1}`).join('\n') +
						'\n\n\n',
				};
			}

			case 'new-session': {
				const name = args[args.indexOf('-s') + 1]!;
				const option = (key: string) => {
					const index = args.indexOf(key);
					return index === -1 ? undefined : args[index + 1];
				};

				splits.push({
					name: name.slice(MAIN.length + 1),
					split: option('@pappa_split')!,
					order: Number(option('@pappa_order')),
					size: option('@pappa_size'),
					paneId: `%${next++}`,
				});
				return {status: 0, stdout: ''};
			}

			case 'set-option': {
				const pane = panes.find(p => p.id === args[3]);
				if (pane && args[4] === '@pappa_pane') pane.name = args[5];
				const split = splits.find(
					each => `${MAIN}~${each.name}` === sessionOf(args[2] ?? ''),
				);
				if (split && args[3] === '@pappa_size') split.size = args[4];
				return {status: 0, stdout: ''};
			}

			case 'kill-session': {
				const index = splits.findIndex(
					each => `${MAIN}~${each.name}` === sessionOf(args[2] ?? ''),
				);
				if (index !== -1) splits.splice(index, 1);
				return {status: 0, stdout: ''};
			}

			default: {
				return {status: 0, stdout: ''};
			}
		}
	};

	return {runner, calls, panes, splits};
}

const deps = (runner: OuterTmuxRunner) => ({runner});

test('an untagged session names its lowest pane main', () => {
	const tmux = fakeTmux([{id: '%7'}, {id: '%3'}]);
	const panes = listCompanion('STA-1', deps(tmux.runner));
	expect(tmux.calls.find(c => c[0] === 'set-option')).toStrictEqual([
		'set-option',
		'-p',
		'-t',
		'%3',
		'@pappa_pane',
		'main',
	]);
	expect(panes.find(p => p.paneId === '%3')?.name).toBe('main');
});

test('a session that already has main is not retagged', () => {
	const tmux = fakeTmux([{id: '%3'}, {id: '%7', name: 'main'}]);
	listCompanion('STA-1', deps(tmux.runner));
	expect(tmux.calls.some(c => c[0] === 'set-option')).toBe(false);
});

test('run on a missing pane starts a split session in the companion directory', () => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}]);
	const before = Date.now();
	const result = runInCompanion(
		'STA-1',
		{pane: 'app', split: 'right', size: '30%', command: 'npm run dev'},
		deps(tmux.runner),
	);
	expect(result).toStrictEqual({created: true});
	const create = tmux.calls.find(c => c[0] === 'new-session')!;
	expect(create.slice(0, 6)).toStrictEqual([
		'new-session',
		'-d',
		'-s',
		'companion-repo-STA-1~app',
		'-c',
		'/work/tree',
	]);
	expect(create.includes('npm run dev')).toBe(true);
	expect(tmux.splits[0]).toMatchObject({
		name: 'app',
		split: 'right',
		size: '30%',
	});
	expect(tmux.splits[0]!.order >= before).toBe(true);
});

test('run on an existing split respawns it and keeps the new size', () => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}], {
		splits: [{name: 'app', split: 'down', order: 1, paneId: '%4'}],
	});
	const result = runInCompanion(
		'STA-1',
		{pane: 'app', split: 'right', size: 12, command: 'make'},
		deps(tmux.runner),
	);
	expect(result).toStrictEqual({created: false});
	expect(tmux.calls.some(c => c[0] === 'new-session')).toBe(false);
	expect(
		tmux.calls.find(c => c[0] === 'respawn-pane')!.slice(0, 6),
	).toStrictEqual(['respawn-pane', '-k', '-t', '%4', '-c', '#{session_path}']);
	expect(tmux.splits[0]).toMatchObject({split: 'down', size: '12'});
});

test('main has no size of its own: run --size and resize are refused before tmux', () => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}]);
	for (const call of [
		() =>
			runInCompanion(
				'STA-1',
				{pane: 'main', split: 'down', size: 10, command: 'x'},
				deps(tmux.runner),
			),
		() =>
			resizeCompanionPane('STA-1', {pane: 'main', size: 10}, deps(tmux.runner)),
	]) {
		const error = thrownBy(call, CompanionError);
		expect(error.message).toMatch(/companion width/);
	}

	expect(tmux.calls.length).toBe(0);
});

test('resize keeps the size on the split for the TUI to apply', () => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}], {
		splits: [{name: 'log', split: 'right', order: 1, paneId: '%2'}],
	});
	resizeCompanionPane('STA-1', {pane: 'log', size: '40%'}, deps(tmux.runner));
	expect(tmux.splits[0]!.size).toBe('40%');
	expect(tmux.calls.some(c => c[0] === 'resize-pane')).toBe(false);
});

test('close refuses main without touching tmux', () => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}]);
	expect(() => closeCompanionPane('STA-1', 'main', deps(tmux.runner))).toThrow(
		CompanionError,
	);
	expect(tmux.calls.length).toBe(0);
});

test('close ends the split session', () => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}], {
		splits: [{name: 'log', split: 'down', order: 1, paneId: '%2'}],
	});
	closeCompanionPane('STA-1', 'log', deps(tmux.runner));
	expect(tmux.calls.at(-1)).toStrictEqual([
		'kill-session',
		'-t',
		'=companion-repo-STA-1~log:',
	]);
	expect(tmux.splits).toStrictEqual([]);
});

test('a pane that is not there is named with the panes that are', () => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}], {
		splits: [{name: 'log', split: 'down', order: 1, paneId: '%2'}],
	});
	const error = thrownBy(
		() => closeCompanionPane('STA-1', 'tests', deps(tmux.runner)),
		CompanionError,
	);
	expect(error.message).toBe(
		'No companion pane named tests (panes: main, log)',
	);
});

test('list shows main, then the splits in the order they were made', () => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}], {
		splits: [
			{name: 'logs', split: 'right', order: 20, paneId: '%3'},
			{name: 'tests', split: 'down', order: 10, size: '30%', paneId: '%2'},
		],
	});
	const panes = listCompanion('STA-1', deps(tmux.runner));
	expect(panes.map(p => [p.name, p.split, p.size])).toStrictEqual([
		['main', null, null],
		['tests', 'down', '30%'],
		['logs', 'right', null],
	]);
});

test('keys types text literally then presses Enter, with no C-u', () => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}]);
	sendCompanionKeys(
		'STA-1',
		{pane: 'main', text: '-x', keys: [], enter: true},
		deps(tmux.runner),
	);
	expect(tmux.calls.filter(c => c[0] === 'send-keys')).toStrictEqual([
		['send-keys', '-t', '%1', '-l', '--', '-x'],
		['send-keys', '-t', '%1', 'Enter'],
	]);
});

test('keys --keys presses key names in order, without -l or Enter', () => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}]);
	sendCompanionKeys(
		'STA-1',
		{pane: 'main', keys: ['q', 'Escape'], enter: true},
		deps(tmux.runner),
	);
	expect(tmux.calls.filter(c => c[0] === 'send-keys')).toStrictEqual([
		['send-keys', '-t', '%1', 'q'],
		['send-keys', '-t', '%1', 'Escape'],
	]);
});

test('a space without a companion session errors and names the session', () => {
	const tmux = fakeTmux([], {sessions: ['agent-repo-STA-1']});
	const error = thrownBy(
		() => listCompanion('STA-1', deps(tmux.runner)),
		CompanionError,
	);
	expect(error.message).toMatch(/companion-repo-STA-1 on pappardelle_inner/);
});

test('no verb targets the agent session', () => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}], {
		sessions: ['agent-repo-STA-1', MAIN],
		splits: [{name: 'app', split: 'down', order: 1, paneId: '%2'}],
	});
	const d = deps(tmux.runner);
	listCompanion('STA-1', d);
	runInCompanion('STA-1', {pane: 'app', split: 'down', command: 'x'}, d);
	runInCompanion('STA-1', {pane: 'new', split: 'down', command: 'x'}, d);
	sendCompanionKeys('STA-1', {pane: 'app', keys: ['q'], enter: true}, d);
	closeCompanionPane('STA-1', 'app', d);
	// One call can chain tmux commands with `;`, and set-option's -s isn't a session.
	const commands: string[][] = [];
	for (const call of tmux.calls) {
		commands.push([]);
		for (const arg of call) {
			if (arg === ';') commands.push([]);
			else commands.at(-1)!.push(arg);
		}
	}

	const targets = commands.flatMap(c =>
		c.filter(
			(_, i) =>
				c[i - 1] === '-t' || (c[0] === 'new-session' && c[i - 1] === '-s'),
		),
	);
	expect(targets.length > 0).toBe(true);
	expect(targets.some(target => target.includes('agent-'))).toBe(false);
	expect(
		targets
			.filter(target => !target.startsWith('%'))
			.every(target => target.replace(/^=|:$/g, '').startsWith(MAIN)),
	).toBe(true);
});

test('read returns only the last N lines of what tmux captured', () => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}]);
	expect(
		readCompanionPane('STA-1', {pane: 'main', lines: 3}, deps(tmux.runner)),
	).toBe('line 28\nline 29\nline 30');
});

test('the companion verbs target the companion session stored for the space', async () => {
	const stored = testState({repo: 'repo', sqlite: true});
	await stored.daos.spaceIdentities.record({
		repo: 'repo',
		key: 'STA-1',
		worktreePath: '/work/tree',
		tmux: {
			socket: 'pappardelle_inner',
			agentSession: 'hand-named-agent',
			companionSession: 'hand-named-companion',
		},
	});
	initTmuxState(stored.daos);
	teardown(() => {
		initTmuxState(derived.daos);
	});
	const runner: OuterTmuxRunner = args => ({
		status: 0,
		stdout:
			args[0] === 'list-sessions'
				? 'companion-repo-STA-1\nhand-named-companion\n'
				: '',
	});
	expect(companionSessionTarget('STA-1', {runner}).target).toBe(
		'=hand-named-companion:',
	);
});
