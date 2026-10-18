import test from 'ava';
import {
	closeCompanionPane,
	CompanionError,
	listCompanion,
	readCompanionPane,
	runInCompanion,
	sendCompanionKeys,
} from './companion.ts';
import type {OuterTmuxRunner} from './tmux.ts';

type Pane = {
	id: string;
	name?: string;
	split?: string;
};

// A tmux stand-in holding one session's pane list. It answers list-panes,
// split-window and set-option, and records every call.
function fakeTmux(panes: Pane[], sessions = ['companion-repo-STA-1']) {
	const calls: string[][] = [];
	let next = 10;
	const runner: OuterTmuxRunner = args => {
		calls.push([...args]);
		switch (args[0] ?? '') {
			case 'list-sessions': {
				return {status: 0, stdout: sessions.join('\n') + '\n'};
			}

			case 'list-panes': {
				return {
					status: 0,
					stdout: panes
						.map(p =>
							[
								p.id,
								p.name ?? '',
								p.split ?? '',
								'zsh',
								'80',
								'24',
								'0',
								'zsh',
							].join('\t'),
						)
						.join('\n'),
				};
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

			case 'split-window': {
				const id = `%${next++}`;
				panes.push({id});
				return {status: 0, stdout: `${id}\n`};
			}

			case 'set-option': {
				const pane = panes.find(p => p.id === args[3]);
				if (pane && args[4] === '@pappa_pane') pane.name = args[5];
				if (pane && args[4] === '@pappa_split') pane.split = args[5];
				return {status: 0, stdout: ''};
			}

			default: {
				return {status: 0, stdout: ''};
			}
		}
	};

	return {runner, calls, panes};
}

const deps = (runner: OuterTmuxRunner) => ({runner, repoName: 'repo'});

test('an untagged session names its lowest pane main', t => {
	const tmux = fakeTmux([{id: '%7'}, {id: '%3'}]);
	const panes = listCompanion('STA-1', deps(tmux.runner));
	t.deepEqual(
		tmux.calls.find(c => c[0] === 'set-option'),
		['set-option', '-p', '-t', '%3', '@pappa_pane', 'main'],
	);
	t.is(panes.find(p => p.paneId === '%3')?.name, 'main');
});

test('a session that already has main is not retagged', t => {
	const tmux = fakeTmux([{id: '%3'}, {id: '%7', name: 'main'}]);
	listCompanion('STA-1', deps(tmux.runner));
	t.false(tmux.calls.some(c => c[0] === 'set-option'));
});

test('run on a missing pane splits it off main and names it', t => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}]);
	const result = runInCompanion(
		'STA-1',
		{pane: 'app', split: 'right', size: '30%', command: 'npm run dev'},
		deps(tmux.runner),
	);
	t.deepEqual(result, {paneId: '%10', created: true});
	const split = tmux.calls.find(c => c[0] === 'split-window')!;
	t.deepEqual(split.slice(0, 13), [
		'split-window',
		'-d',
		'-h',
		'-l',
		'30%',
		'-t',
		'%1',
		'-c',
		'#{session_path}',
		'-P',
		'-F',
		'#{pane_id}',
		'/bin/sh',
	]);
	t.is(split.at(-1), 'npm run dev');
	t.deepEqual(tmux.panes.at(-1), {id: '%10', name: 'app', split: 'right'});
});

test('run on an existing pane respawns it instead of splitting', t => {
	const tmux = fakeTmux([
		{id: '%1', name: 'main'},
		{id: '%4', name: 'app', split: 'down'},
	]);
	const result = runInCompanion(
		'STA-1',
		{pane: 'app', split: 'right', size: '12', command: 'make'},
		deps(tmux.runner),
	);
	t.deepEqual(result, {paneId: '%4', created: false});
	t.false(tmux.calls.some(c => c[0] === 'split-window'));
	t.deepEqual(tmux.calls.find(c => c[0] === 'respawn-pane')!.slice(0, 6), [
		'respawn-pane',
		'-k',
		'-t',
		'%4',
		'-c',
		'#{session_path}',
	]);
	// --size resizes along the axis the pane was split on, not --split.
	t.deepEqual(
		tmux.calls.find(c => c[0] === 'resize-pane'),
		['resize-pane', '-t', '%4', '-y', '12'],
	);
});

test('run --size on main has no axis and is refused', t => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}]);
	t.throws(
		() =>
			runInCompanion(
				'STA-1',
				{pane: 'main', split: 'down', size: '10', command: 'x'},
				deps(tmux.runner),
			),
		{instanceOf: CompanionError},
	);
	t.false(tmux.calls.some(c => c[0] === 'respawn-pane'));
});

test('close refuses main without touching tmux', t => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}]);
	t.throws(() => closeCompanionPane('STA-1', 'main', deps(tmux.runner)), {
		instanceOf: CompanionError,
	});
	t.is(tmux.calls.length, 0);
});

test('close kills the named pane', t => {
	const tmux = fakeTmux([
		{id: '%1', name: 'main'},
		{id: '%2', name: 'log'},
	]);
	closeCompanionPane('STA-1', 'log', deps(tmux.runner));
	t.deepEqual(tmux.calls.at(-1), ['kill-pane', '-t', '%2']);
});

test('keys types text literally then presses Enter, with no C-u', t => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}]);
	sendCompanionKeys(
		'STA-1',
		{pane: 'main', text: '-x', keys: [], enter: true},
		deps(tmux.runner),
	);
	t.deepEqual(
		tmux.calls.filter(c => c[0] === 'send-keys'),
		[
			['send-keys', '-t', '%1', '-l', '--', '-x'],
			['send-keys', '-t', '%1', 'Enter'],
		],
	);
});

test('keys --keys presses key names in order, without -l or Enter', t => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}]);
	sendCompanionKeys(
		'STA-1',
		{pane: 'main', keys: ['q', 'Escape'], enter: true},
		deps(tmux.runner),
	);
	t.deepEqual(
		tmux.calls.filter(c => c[0] === 'send-keys'),
		[
			['send-keys', '-t', '%1', 'q'],
			['send-keys', '-t', '%1', 'Escape'],
		],
	);
});

test('a space without a companion session errors and names the session', t => {
	const tmux = fakeTmux([], ['agent-repo-STA-1']);
	const error = t.throws(() => listCompanion('STA-1', deps(tmux.runner)), {
		instanceOf: CompanionError,
	});
	t.regex(error.message, /companion-repo-STA-1 on pappardelle_inner/);
});

test('no verb targets the agent session', t => {
	const tmux = fakeTmux(
		[
			{id: '%1', name: 'main'},
			{id: '%2', name: 'app', split: 'down'},
		],
		['agent-repo-STA-1', 'companion-repo-STA-1'],
	);
	const d = deps(tmux.runner);
	listCompanion('STA-1', d);
	runInCompanion('STA-1', {pane: 'app', split: 'down', command: 'x'}, d);
	sendCompanionKeys('STA-1', {pane: 'app', keys: ['q'], enter: true}, d);
	closeCompanionPane('STA-1', 'app', d);
	const targets = tmux.calls.flatMap(c =>
		c.filter((_, i) => c[i - 1] === '-t'),
	);
	t.true(targets.length > 0);
	t.false(targets.some(target => target.includes('agent-')));
	t.true(
		targets
			.filter(target => target.startsWith('='))
			.every(target => target === '=companion-repo-STA-1:'),
	);
});

test('read returns only the last N lines of what tmux captured', t => {
	const tmux = fakeTmux([{id: '%1', name: 'main'}]);
	t.is(
		readCompanionPane('STA-1', {pane: 'main', lines: 3}, deps(tmux.runner)),
		'line 28\nline 29\nline 30',
	);
});
