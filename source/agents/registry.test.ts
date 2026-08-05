import test from 'ava';
import type {AgentCli, AgentState} from '../types.ts';
import {COLORS} from '../types.ts';
import {
	buildAgentResumeCommand,
	getAgentDescriptor,
	getAgentSpinnerColor,
	listAgentDescriptors,
	mapHookEventToState,
} from './registry.ts';

const AGENTS: AgentCli[] = ['claude', 'codex'];

// ============================================================================
// Descriptors
// ============================================================================

test('every registered agent has a descriptor keyed by its own id', t => {
	for (const agent of AGENTS) {
		t.is(getAgentDescriptor(agent).id, agent);
	}

	t.is(listAgentDescriptors().length, AGENTS.length);
});

test('each agent has a distinct spinner color', t => {
	const colors = listAgentDescriptors().map(d => d.spinnerColor);
	t.is(new Set(colors).size, colors.length);
	t.is(getAgentSpinnerColor('claude'), COLORS.CLAUDE_ORANGE);
	t.is(getAgentSpinnerColor('codex'), COLORS.CODEX_GREEN);
});

test('an unresolved agent falls back to Claude orange (pre-STA-1850 look)', t => {
	t.is(getAgentSpinnerColor(undefined), COLORS.CLAUDE_ORANGE);
});

test('only Claude needs directory pre-trust', t => {
	t.true(getAgentDescriptor('claude').needsPretrust);
	t.false(getAgentDescriptor('codex').needsPretrust);
});

test('the question tool is the per-agent divergence in the event table', t => {
	t.is(getAgentDescriptor('claude').questionTool, 'AskUserQuestion');
	t.is(getAgentDescriptor('codex').questionTool, 'request_user_input');
});

// ============================================================================
// Event → state mapping (shared table)
// ============================================================================

const SHARED_TABLE: Array<[string, AgentState]> = [
	['UserPromptSubmit', 'working'],
	['PreToolUse', 'working'],
	['PostToolUse', 'working'],
	['PreCompact', 'working'],
	['PostCompact', 'working'],
	['SubagentStart', 'working'],
	['PermissionRequest', 'needs-approval'],
	['Stop', 'done'],
	['SubagentStop', 'done'],
	['SessionStart', 'idle'],
	['SessionEnd', 'idle'],
];

for (const agent of AGENTS) {
	for (const [event, expected] of SHARED_TABLE) {
		test(`${agent}: ${event} → ${expected}`, t => {
			t.is(mapHookEventToState(agent, event), expected);
		});
	}

	test(`${agent}: PreToolUse on the question tool → needs-answer`, t => {
		const {questionTool} = getAgentDescriptor(agent);
		t.is(
			mapHookEventToState(agent, 'PreToolUse', {toolName: questionTool}),
			'needs-answer',
		);
	});

	test(`${agent}: PreToolUse on any other tool stays working`, t => {
		t.is(
			mapHookEventToState(agent, 'PreToolUse', {toolName: 'Bash'}),
			'working',
		);
	});

	test(`${agent}: PermissionRequest for the question tool reads as a question`, t => {
		const {questionTool} = getAgentDescriptor(agent);
		t.is(
			mapHookEventToState(agent, 'PermissionRequest', {toolName: questionTool}),
			'needs-answer',
		);
	});

	test(`${agent}: an unknown event writes nothing`, t => {
		t.is(mapHookEventToState(agent, 'TotallyMadeUp'), null);
		t.is(mapHookEventToState(agent, ''), null);
	});

	test(`${agent}: the other agent's question tool is not special-cased`, t => {
		const other = agent === 'claude' ? 'codex' : 'claude';
		const foreignTool = getAgentDescriptor(other).questionTool;
		t.is(
			mapHookEventToState(agent, 'PreToolUse', {toolName: foreignTool}),
			'working',
		);
	});
}

// ============================================================================
// Claude's extra Notification event
// ============================================================================

test('claude: Notification/idle_prompt → done', t => {
	t.is(
		mapHookEventToState('claude', 'Notification', {
			notificationType: 'idle_prompt',
		}),
		'done',
	);
});

test('claude: Notification/permission_prompt writes nothing (PermissionRequest already did)', t => {
	t.is(
		mapHookEventToState('claude', 'Notification', {
			notificationType: 'permission_prompt',
		}),
		null,
	);
});

test('claude: an undiscriminated Notification writes nothing', t => {
	t.is(mapHookEventToState('claude', 'Notification'), null);
});

test('codex: Notification is not one of its events and writes nothing', t => {
	t.is(
		mapHookEventToState('codex', 'Notification', {
			notificationType: 'idle_prompt',
		}),
		null,
	);
});

// ============================================================================
// Resume commands
// ============================================================================

test('claude resume keeps --name and the --continue fallback chain', t => {
	const cmd = buildAgentResumeCommand('claude', 'STA-123');
	t.is(
		cmd,
		`claude --name STA-123 --continue || { printf '\\033[A\\033[2K'; false; } || claude --name STA-123`,
	);
});

test('claude skip-permissions maps to --dangerously-skip-permissions on both branches', t => {
	const cmd = buildAgentResumeCommand('claude', 'STA-123', true);
	t.is(cmd.match(/--dangerously-skip-permissions/g)?.length, 2);
});

test('codex resumes the last thread in the cwd, falling back to a fresh session', t => {
	const cmd = buildAgentResumeCommand('codex', 'STA-123');
	t.is(
		cmd,
		`codex resume --last || { printf '\\033[A\\033[2K'; false; } || codex`,
	);
});

test('codex skip-permissions maps to --dangerously-bypass-approvals-and-sandbox', t => {
	const cmd = buildAgentResumeCommand('codex', 'STA-123', true);
	t.is(cmd.match(/--dangerously-bypass-approvals-and-sandbox/g)?.length, 2);
	t.false(cmd.includes('--dangerously-skip-permissions'));
});

test('codex is never given Claude-only flags', t => {
	const cmd = buildAgentResumeCommand('codex', 'STA-123');
	t.false(cmd.includes('--name'));
	t.false(cmd.includes('--continue'));
});

test('a shell-hostile issue key is quoted, not interpolated raw', t => {
	const cmd = buildAgentResumeCommand('claude', 'STA-1; rm -rf /');
	t.false(cmd.includes('--name STA-1; rm'));
	t.true(cmd.includes(`'STA-1; rm -rf /'`));
});
