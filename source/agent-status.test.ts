import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import type {AgentState, AgentStatusFile} from './types.ts';
import {
	AGENT_STATE_DISPLAY,
	AGENT_STATUS_SCHEMA,
	STABLE_STATES,
	ACTIVE_STATES,
	ACTIVE_STATUS_TIMEOUT,
	UNKNOWN_STATE_DISPLAY,
	stateNeedsAttention,
} from './types.ts';
import {
	findSpaceByStatusKey,
	getAgentStatus,
	setAgentStatus,
	watchStatuses,
} from './agent-status.ts';
import {clearRecentErrors, getRecentErrors} from './logger.ts';

const ALL_STATES: AgentState[] = [
	'idle',
	'working',
	'needs-approval',
	'needs-answer',
	'done',
];

function withStatusDir(t: ExecutionContext): string {
	const dir = mkdtempSync(path.join(tmpdir(), 'papp-agent-status-'));
	const previous = process.env['PAPPARDELLE_STATUS_DIR'];
	process.env['PAPPARDELLE_STATUS_DIR'] = dir;
	t.teardown(() => {
		if (previous === undefined) {
			delete process.env['PAPPARDELLE_STATUS_DIR'];
		} else {
			process.env['PAPPARDELLE_STATUS_DIR'] = previous;
		}
		rmSync(dir, {recursive: true, force: true});
	});
	return dir;
}

function writeRawStatus(
	dir: string,
	statusKey: string,
	file: Partial<AgentStatusFile>,
): void {
	writeFileSync(
		path.join(dir, `${statusKey}.json`),
		JSON.stringify(file, null, 2),
	);
}

// ============================================================================
// State vocabulary
// ============================================================================

test('the state vocabulary is exactly five values, each categorized once', t => {
	for (const state of ALL_STATES) {
		const inStable = STABLE_STATES.has(state);
		const inActive = ACTIVE_STATES.has(state);
		t.true(inStable || inActive, `${state} must be categorized`);
		t.false(inStable && inActive, `${state} must not be in both sets`);
	}

	t.is(STABLE_STATES.size + ACTIVE_STATES.size, ALL_STATES.length);
});

test('working is the only state that can go stale', t => {
	t.deepEqual([...ACTIVE_STATES], ['working']);
	t.true(STABLE_STATES.has('needs-answer'));
	t.true(STABLE_STATES.has('needs-approval'));
	t.true(STABLE_STATES.has('idle'));
	t.true(STABLE_STATES.has('done'));
});

test('ACTIVE_STATUS_TIMEOUT is 10 minutes', t => {
	t.is(ACTIVE_STATUS_TIMEOUT, 10 * 60 * 1000);
});

// ============================================================================
// Display mapping — parity with the pre-STA-1850 icons
// ============================================================================

test('AGENT_STATE_DISPLAY keeps the icons Charlie already reads', t => {
	// working renders the spinner, so it carries no icon.
	t.is(AGENT_STATE_DISPLAY.working.icon, undefined);
	t.is(AGENT_STATE_DISPLAY.idle.icon, '●');
	t.is(AGENT_STATE_DISPLAY.idle.color, 'green');
	t.is(AGENT_STATE_DISPLAY.done.icon, '●');
	t.is(AGENT_STATE_DISPLAY.done.color, 'green');
	t.is(AGENT_STATE_DISPLAY['needs-approval'].icon, '!');
	t.is(AGENT_STATE_DISPLAY['needs-approval'].color, 'red');
	t.is(AGENT_STATE_DISPLAY['needs-answer'].icon, '?');
	t.is(AGENT_STATE_DISPLAY['needs-answer'].color, 'blue');
});

test('a space with no status file renders the gray unknown marker', t => {
	t.is(UNKNOWN_STATE_DISPLAY.icon, '?');
	t.is(UNKNOWN_STATE_DISPLAY.color, 'gray');
});

test('both blocked states demand attention; nothing else does', t => {
	t.true(stateNeedsAttention('needs-approval'));
	t.true(stateNeedsAttention('needs-answer'));
	t.false(stateNeedsAttention('working'));
	t.false(stateNeedsAttention('idle'));
	t.false(stateNeedsAttention('done'));
	t.false(stateNeedsAttention(undefined));
});

// ============================================================================
// Round-trip
// ============================================================================

test('every state round-trips through write and read, for every agent', t => {
	withStatusDir(t);

	for (const agent of ['claude', 'codex'] as const) {
		for (const state of ALL_STATES) {
			const key = `RT-${agent}-${state}`;
			setAgentStatus(key, agent, state);
			const info = getAgentStatus(key);
			t.truthy(info, `${agent}/${state} should read back`);
			t.is(info?.agent, agent);
			t.is(info?.state, state);
		}
	}
});

test('the written file carries the schema version and statusKey', t => {
	const dir = withStatusDir(t);
	setAgentStatus('STA-1', 'claude', 'working', {
		sessionId: 'sess-1',
		cwd: '/tmp/wt',
		decoration: {tool: 'Bash', model: 'claude-opus-5'},
	});

	const parsed = JSON.parse(
		readFileSync(path.join(dir, 'STA-1.json'), 'utf-8'),
	) as AgentStatusFile;
	t.is(parsed.schema, AGENT_STATUS_SCHEMA);
	t.is(parsed.statusKey, 'STA-1');
	t.is(parsed.agent, 'claude');
	t.is(parsed.sessionId, 'sess-1');
	t.is(parsed.cwd, '/tmp/wt');
	t.deepEqual(parsed.decoration, {tool: 'Bash', model: 'claude-opus-5'});
});

test('an empty decoration is omitted rather than written as {}', t => {
	const dir = withStatusDir(t);
	setAgentStatus('STA-2', 'codex', 'idle', {decoration: {}});
	const parsed = JSON.parse(
		readFileSync(path.join(dir, 'STA-2.json'), 'utf-8'),
	) as AgentStatusFile;
	t.is(parsed.decoration, undefined);
});

// ============================================================================
// Cross-harness bleed guard — the STA-1120 bug this schema exists to prevent
// ============================================================================

test('a Claude status file is treated as absent when the space runs Codex', t => {
	withStatusDir(t);
	setAgentStatus('STA-3', 'claude', 'working');

	t.is(getAgentStatus('STA-3', 'codex'), null);
	t.is(getAgentStatus('STA-3', 'claude')?.state, 'working');
});

test('a Codex status file is treated as absent when the space runs Claude', t => {
	withStatusDir(t);
	setAgentStatus('STA-4', 'codex', 'needs-approval');

	t.is(getAgentStatus('STA-4', 'claude'), null);
	t.is(getAgentStatus('STA-4', 'codex')?.state, 'needs-approval');
});

test('omitting the expected agent reads whatever wrote the file', t => {
	withStatusDir(t);
	setAgentStatus('STA-5', 'codex', 'done');
	t.is(getAgentStatus('STA-5')?.agent, 'codex');
});

test('a file with no agent field is rejected — it predates the schema', t => {
	const dir = withStatusDir(t);
	writeRawStatus(dir, 'STA-6', {
		schema: 1,
		state: 'working',
		statusKey: 'STA-6',
		lastUpdate: Date.now(),
	});
	t.is(getAgentStatus('STA-6'), null);
});

test('a file naming an unknown agent is rejected', t => {
	const dir = withStatusDir(t);
	writeFileSync(
		path.join(dir, 'STA-7.json'),
		JSON.stringify({
			schema: 1,
			agent: 'cursor',
			state: 'working',
			statusKey: 'STA-7',
			lastUpdate: Date.now(),
		}),
	);
	t.is(getAgentStatus('STA-7'), null);
});

// ============================================================================
// Staleness
// ============================================================================

test('a working status older than the timeout reads as unknown', t => {
	const dir = withStatusDir(t);
	writeRawStatus(dir, 'STA-8', {
		schema: 1,
		agent: 'claude',
		state: 'working',
		statusKey: 'STA-8',
		lastUpdate: Date.now() - ACTIVE_STATUS_TIMEOUT - 1000,
	});
	t.is(getAgentStatus('STA-8'), null);
});

test('a working status inside the timeout still reads', t => {
	const dir = withStatusDir(t);
	writeRawStatus(dir, 'STA-9', {
		schema: 1,
		agent: 'claude',
		state: 'working',
		statusKey: 'STA-9',
		lastUpdate: Date.now() - 1000,
	});
	t.is(getAgentStatus('STA-9')?.state, 'working');
});

test('stable states never go stale, however old', t => {
	const dir = withStatusDir(t);
	const ancient = Date.now() - ACTIVE_STATUS_TIMEOUT * 100;
	for (const state of [
		'idle',
		'done',
		'needs-approval',
		'needs-answer',
	] as const) {
		const key = `STALE-${state}`;
		writeRawStatus(dir, key, {
			schema: 1,
			agent: 'claude',
			state,
			statusKey: key,
			lastUpdate: ancient,
		});
		t.is(
			getAgentStatus(key)?.state,
			state,
			`${state} must survive an ancient lastUpdate — a human may take an hour`,
		);
	}
});

// ============================================================================
// Malformed / partial input
// ============================================================================

test('a missing file reads as unknown', t => {
	withStatusDir(t);
	t.is(getAgentStatus('NOPE'), null);
});

test('an empty file (mid-truncate race) reads as unknown without throwing', t => {
	const dir = withStatusDir(t);
	writeFileSync(path.join(dir, 'STA-10.json'), '');
	t.notThrows(() => getAgentStatus('STA-10'));
	t.is(getAgentStatus('STA-10'), null);
});

test('malformed JSON reads as unknown without throwing', t => {
	const dir = withStatusDir(t);
	writeFileSync(path.join(dir, 'STA-11.json'), '{not really json');
	t.notThrows(() => getAgentStatus('STA-11'));
	t.is(getAgentStatus('STA-11'), null);
});

test('a JSON array is rejected rather than coerced', t => {
	const dir = withStatusDir(t);
	writeFileSync(path.join(dir, 'STA-12.json'), '[]');
	t.is(getAgentStatus('STA-12'), null);
});

test('an unrecognized state value is rejected', t => {
	const dir = withStatusDir(t);
	writeFileSync(
		path.join(dir, 'STA-13.json'),
		JSON.stringify({
			schema: 1,
			agent: 'claude',
			state: 'compacting',
			statusKey: 'STA-13',
			lastUpdate: Date.now(),
		}),
	);
	t.is(getAgentStatus('STA-13'), null);
});

test('a missing lastUpdate is rejected — staleness cannot be evaluated', t => {
	const dir = withStatusDir(t);
	writeRawStatus(dir, 'STA-14', {
		schema: 1,
		agent: 'claude',
		state: 'working',
		statusKey: 'STA-14',
	});
	t.is(getAgentStatus('STA-14'), null);
});

test('read failures stay at debug level and never reach the TUI error pane', t => {
	const dir = withStatusDir(t);
	writeFileSync(path.join(dir, 'STA-15.json'), '');

	clearRecentErrors();
	getAgentStatus('STA-15');
	const surfaced = getRecentErrors().filter(
		e => e.component === 'agent-status',
	);
	t.deepEqual(surfaced, []);
});

// ============================================================================
// Atomic write
// ============================================================================

test('setAgentStatus is atomic — rewrite replaces the inode', t => {
	const dir = withStatusDir(t);
	const filePath = path.join(dir, 'STA-20.json');

	setAgentStatus('STA-20', 'claude', 'working');
	const before = statSync(filePath).ino;
	setAgentStatus('STA-20', 'claude', 'done');
	const after = statSync(filePath).ino;

	// An atomic rename swaps the directory entry to a brand-new inode; an
	// in-place writeFileSync would truncate and reuse the same inode.
	t.not(before, after);
});

test('a successful write leaves no .tmp sibling behind', t => {
	const dir = withStatusDir(t);
	setAgentStatus('STA-21', 'claude', 'working');
	setAgentStatus('STA-21', 'claude', 'idle');
	t.deepEqual(
		readdirSync(dir).filter(f => f.includes('.tmp.')),
		[],
	);
});

test('a failed write cleans up its tmp orphan before rethrowing', t => {
	const dir = withStatusDir(t);
	// renameSync of a regular file onto a non-empty directory fails, so the
	// writer's catch must rm the tmp sibling before rethrowing.
	const targetAsDir = path.join(dir, 'STA-22.json');
	mkdirSync(targetAsDir);
	writeFileSync(path.join(targetAsDir, 'placeholder'), 'x');

	t.throws(() => setAgentStatus('STA-22', 'claude', 'working'));
	t.deepEqual(
		readdirSync(dir).filter(f => f.includes('.tmp.')),
		[],
	);
});

// ============================================================================
// findSpaceByStatusKey (unchanged semantics, carried over)
// ============================================================================

test('findSpaceByStatusKey matches the main worktree by its qualified key', t => {
	const spaces = [
		{name: 'main', statusKey: 'pappa-chex-main'},
		{name: 'STA-123'},
	];
	t.is(findSpaceByStatusKey(spaces, 'pappa-chex-main'), 0);
	// Bare "main" must NOT match — prevents cross-repo collision.
	t.is(findSpaceByStatusKey(spaces, 'main'), -1);
	t.is(findSpaceByStatusKey(spaces, 'STA-123'), 1);
	t.is(findSpaceByStatusKey(spaces, 'nope'), -1);
});

// ============================================================================
// Watcher
// ============================================================================

test('watchStatuses surfaces only .json events, never .tmp.<pid> ones', async t => {
	withStatusDir(t);
	const seen: string[] = [];

	const stop = watchStatuses(key => {
		seen.push(key);
	});
	t.teardown(stop);

	setAgentStatus('STA-30', 'claude', 'working');
	setAgentStatus('STA-30', 'claude', 'done');

	await new Promise<void>(resolve => {
		setTimeout(resolve, 50);
	});

	t.true(
		seen.every(k => !k.includes('.tmp.')),
		`watcher leaked a temp-file event: ${JSON.stringify(seen)}`,
	);
});
