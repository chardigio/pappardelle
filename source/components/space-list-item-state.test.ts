/**
 * Pins the row decisions SpaceListItem makes from a space's normalized agent
 * state: which icon, which color, whether the row blinks, and which spinner
 * color the working animation gets.
 *
 * ava runs under Node's `--experimental-strip-types`, which can't transform the
 * JSX in `SpaceListItem.tsx` — so, like `space-list-item-emoji.test.ts`, this
 * exercises the exact helpers the component calls rather than importing it. The
 * expressions below are copied verbatim from the component; if they drift, the
 * "mirrors the component" tests are the ones that should be updated together.
 */
import test from 'ava';
import type {AgentState, SpaceData} from '../types.ts';
import {
	AGENT_STATE_DISPLAY,
	COLORS,
	UNKNOWN_STATE_DISPLAY,
	stateNeedsAttention,
} from '../types.ts';
import {getAgentSpinnerColor} from '../agents/registry.ts';

/** Mirror of SpaceListItem's icon/color selection. */
function statusInfo(space: Partial<SpaceData>): {color: string; icon?: string} {
	return space.agentState
		? AGENT_STATE_DISPLAY[space.agentState]
		: UNKNOWN_STATE_DISPLAY;
}

/** Mirror of SpaceListItem's spinner condition. */
function isWorking(space: Partial<SpaceData>): boolean {
	return Boolean(space.isPending) || space.agentState === 'working';
}

// ============================================================================
// The regression this feature exists to fix
// ============================================================================

test('a space blocked on a question flags for attention', t => {
	// Before STA-1850 the row's attention check was
	// `claudeStatus === 'waiting_for_approval'`, while the hook wrote
	// `running_tool` for a PreToolUse:AskUserQuestion. A space waiting on the
	// human for an answer therefore sat there un-blinking, indistinguishable
	// from one that was busy working.
	t.true(stateNeedsAttention('needs-answer'));
});

test('a question renders the blue ? and an approval the red !', t => {
	t.deepEqual(statusInfo({agentState: 'needs-answer'}), {
		color: 'blue',
		icon: '?',
	});
	t.deepEqual(statusInfo({agentState: 'needs-approval'}), {
		color: 'red',
		icon: '!',
	});
});

test('a question is a state, not an approval-plus-tool-name inference', t => {
	// The old code had to read the tool name off the status file to tell a
	// question from a permission prompt. A decoration is explicitly allowed to
	// be missing, so that inference could never be reliable across harnesses.
	t.true(stateNeedsAttention('needs-answer'));
	t.deepEqual(statusInfo({agentState: 'needs-answer', agentDecoration: {}}), {
		color: 'blue',
		icon: '?',
	});
});

// ============================================================================
// Attention
// ============================================================================

test('only the two blocked states blink the row', t => {
	const states: AgentState[] = [
		'idle',
		'working',
		'needs-approval',
		'needs-answer',
		'done',
	];
	const blinking = states.filter(s => stateNeedsAttention(s));
	t.deepEqual(blinking, ['needs-approval', 'needs-answer']);
});

test('a space with no status file does not blink', t => {
	t.false(stateNeedsAttention(undefined));
});

// ============================================================================
// Icons
// ============================================================================

test('a space with no readable status renders the gray unknown marker', t => {
	t.deepEqual(statusInfo({}), {color: 'gray', icon: '?'});
});

test('idle and done both render the green dot, as they did pre-STA-1850', t => {
	// Semantically distinct (nothing pending vs. output waiting to be read) and
	// consumed as such by sous-chef, but splitting them visually would be a
	// behavior change nobody asked for.
	t.deepEqual(statusInfo({agentState: 'idle'}), {color: 'green', icon: '●'});
	t.deepEqual(statusInfo({agentState: 'done'}), {color: 'green', icon: '●'});
});

test('working carries no icon — the spinner takes that cell', t => {
	t.is(statusInfo({agentState: 'working'}).icon, undefined);
});

// ============================================================================
// Spinner
// ============================================================================

test('the spinner shows for a working space and for a pending row', t => {
	t.true(isWorking({agentState: 'working'}));
	t.true(isWorking({isPending: true}));
	// A pending row spins even before any status file exists for it.
	t.true(isWorking({isPending: true, agentState: undefined}));
});

test('the spinner does not show for any settled state', t => {
	for (const state of [
		'idle',
		'done',
		'needs-approval',
		'needs-answer',
	] as const) {
		t.false(isWorking({agentState: state}), `${state} must not spin`);
	}

	t.false(isWorking({}));
});

test('spinner color follows the space agent', t => {
	t.is(getAgentSpinnerColor('claude'), COLORS.CLAUDE_ORANGE);
	t.is(getAgentSpinnerColor('codex'), COLORS.CODEX_GREEN);
	t.not(getAgentSpinnerColor('claude'), getAgentSpinnerColor('codex'));
});

test('a space with no resolved agent keeps the pre-STA-1850 orange spinner', t => {
	t.is(getAgentSpinnerColor(undefined), COLORS.CLAUDE_ORANGE);
});
