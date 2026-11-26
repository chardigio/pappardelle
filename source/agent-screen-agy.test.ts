import {test, expect} from 'bun:test';
import {agentScreenFixture} from '../test/helpers/agent-screens.ts';
import {
	parseAgentScreen,
	parseAgySubagentManageApproval,
	parseResetTime,
} from './agent-screen.ts';
import {classifyAgent} from './agent-state.ts';

const NOW = new Date(2026, 10, 9, 12, 0);
const AGY_RULE = '────────────────────────────────────────';
const AGY_FOOTER = 'esc to cancel    auto · Gemini 4 Hydrogen · medium';
const screen = (name: string, now = NOW) =>
	parseAgentScreen(agentScreenFixture(name), now);

function agyPermissionScreen({
	above = [],
	header,
	body,
	question,
	options,
	footer = '  ↑/↓ Navigate',
}: {
	above?: string[];
	header: string;
	body: string[];
	question: string;
	options: string[];
	footer?: string;
}) {
	return parseAgentScreen(
		[
			...above,
			header,
			AGY_RULE,
			'',
			...body,
			'',
			question,
			...options,
			'',
			footer,
			AGY_FOOTER,
		].join('\n'),
		NOW,
	);
}

function agySubagentBannerScreen(
	who: string,
	tool: string,
	callLines: string[],
) {
	return parseAgentScreen(
		[
			` ┃ ${who} needs approval for ${tool}`,
			' ┃ ────────────────────',
			' ┃',
			...callLines,
			' ┃',
			' ┃ ctrl+k approve · alt+j manage',
			'────────────────────',
			'\u001B[94m>\u001B[39m',
			'────────────────────',
			'? for shortcuts    auto · Gemini 4 Hydrogen · medium · 1 subagent(s)',
		].join('\n'),
		NOW,
	);
}

test('agy permission prompts parse Command, Create file, File access (Read vs non-Read) and MCP cleanly', () => {
	const shell = screen('agy-permission-shell');
	expect(shell.agyDialog).toBe(null);
	expect(shell.codexDialog).toBe(null);
	expect(shell.composer).toBe(null);
	expect(shell.permission).toMatchObject({
		tool: 'Bash command',
		subagent: null,
		command: 'printf qa > qa.txt',
		question: 'Run this command?',
		choose: 'digit',
		source: 'agy',
		cutOff: false,
	});
	expect(
		shell.permission?.options.map(option => [
			option.number,
			option.kind,
			option.selected,
		]),
	).toStrictEqual([
		[1, 'approve_once', true],
		[2, 'deny', false],
	]);

	const shellFactory = screen('agy-permission-shell-factory');
	expect(shellFactory.permission).toMatchObject({
		tool: 'Bash command',
		command: 'printf qa > qa.txt',
		source: 'agy',
		cutOff: false,
	});
	expect(
		shellFactory.permission?.options.map(option => [
			option.number,
			option.kind,
		]),
	).toStrictEqual([
		[1, 'approve_once'],
		[2, 'approve_always'],
		[3, 'approve_always'],
		[4, 'deny'],
	]);

	const truncated = screen('agy-permission-shell-truncated');
	expect(truncated.permission).toMatchObject({
		tool: 'Bash command',
		source: 'agy',
		cutOff: true,
	});
	expect(truncated.permission?.command).toContain('printf 1 >> tall.txt');
	expect(truncated.permission?.command).toContain('⋯ (26 lines hidden)');

	for (const [name, expectedPath] of [
		['agy-permission-edit', '/tmp/q-agy-d/home/.worktrees/qagy-d/qa-b2/x.txt'],
		[
			'agy-permission-edit-factory',
			'/tmp/q-agy-dfac/home/.worktrees/qagy-dfac/qa-a1/x.txt',
		],
	] as const) {
		const edit = screen(name);
		expect(edit.permission, name).toMatchObject({
			tool: 'Create file',
			filePath: expectedPath,
			command: '  1  +  hello',
			question: 'Allow creation of this file?',
			choose: 'digit',
			source: 'agy',
			cutOff: false,
		});
		expect(
			edit.permission?.options.map(option => option.kind),
			name,
		).toStrictEqual(['approve_once', 'deny']);
	}

	const readInside = screen('agy-permission-read');
	expect(readInside.permission).toMatchObject({
		tool: 'Read file',
		filePath: '/tmp/q-agy-d/home/.worktrees/qagy-d/qa-b2/AGENTS.md',
		question: 'Allow access to this file?',
		choose: 'digit',
		source: 'agy',
		cutOff: false,
	});
	expect(
		readInside.permission?.options.map(option => option.kind),
	).toStrictEqual(['approve_once', 'deny']);

	const readOutside = screen('agy-permission-read-outside');
	expect(readOutside.permission).toMatchObject({
		tool: 'Read file',
		filePath: '/etc/hostname',
		source: 'agy',
		cutOff: false,
	});

	// Non-Read File access must stay `File access`, never `Read file`.
	const writeAccess = agyPermissionScreen({
		header: 'File access',
		body: [
			'Write: /tmp/q-agy-d/home/.worktrees/qagy-d/qa-b2/.claude/settings.json',
		],
		question: 'Allow access to this file?',
		options: ['> 1. Yes, allow access', '  2. No, deny access'],
	});
	expect(writeAccess.permission).toMatchObject({
		tool: 'File access',
		filePath: '/tmp/q-agy-d/home/.worktrees/qagy-d/qa-b2/.claude/settings.json',
		source: 'agy',
	});

	const mcp = screen('agy-permission-mcp');
	expect(mcp.permission).toMatchObject({
		tool: 'MCP',
		description: 'qastub/qa_echo',
		command: 'qastub/qa_echo({"text":"hi"})',
		question: 'Allow calling this tool?',
		choose: 'digit',
		source: 'agy',
		cutOff: false,
	});
	expect(mcp.permission?.options.map(option => option.kind)).toStrictEqual([
		'approve_once',
		'deny',
		'deny',
		'deny',
	]);
});

test('agy /config and /model pickers parse as agyDialog with composer null', () => {
	for (const [name, expected] of [
		['agy-config', 'config'],
		['agy-config-factory', 'config'],
		['agy-model-picker', 'model_picker'],
	] as const) {
		const parsed = screen(name);
		expect(parsed.agyDialog, name).toBe(expected);
		expect(parsed.codexDialog, name).toBe(null);
		expect(parsed.permission, name).toBe(null);
		expect(parsed.composer, name).toBe(null);
		expect(parsed.agyComposer, name).toBe(null);
	}
});

test('agy subagent approval banners parse subagent, tool, command, vimInsert and shortcuts', () => {
	const bash = screen('agy-subagent-banner-1');
	expect(bash.agyDialog).toBe(null);
	expect(bash.composer).toBe(null);
	expect(bash.permission).toStrictEqual({
		tool: 'Bash command',
		subagent: 'self',
		description: '',
		command: 'printf a > sub-1.txt',
		question: 'self needs approval for Bash',
		options: [
			{
				number: 1,
				label: 'Yes, approve',
				kind: 'approve_once',
				selected: true,
				shortcut: 'C-k',
			},
			{
				number: 2,
				label: 'No, deny',
				kind: 'deny',
				selected: false,
				shortcut: 'M-j',
			},
		],
		choose: 'shortcut',
		source: 'agy',
		subagentBanner: {vimInsert: true},
		cutOff: false,
	});

	const mcp = screen('agy-subagent-banner-mcp');
	expect(mcp.permission).toMatchObject({
		tool: 'qastub/qa_echo',
		subagent: 'self',
		command: '{"text":"sub-1"}',
		choose: 'shortcut',
		source: 'agy',
		subagentBanner: {vimInsert: false},
		cutOff: false,
	});

	const wrapped = agySubagentBannerScreen('research', 'Bash', [
		' ┃ ● Bash(rm -rf',
		' ┃   /home/u)',
	]);
	expect(wrapped.permission).toMatchObject({
		tool: 'Bash command',
		subagent: 'research',
		command: 'rm -rf\n/home/u',
		subagentBanner: {vimInsert: false},
		cutOff: false,
	});

	// Truncated subagent calls (`...)`, `…`, or missing closing `)`) set cutOff: true.
	for (const callLine of [
		' ┃ ● Bash(printf a > sub.txt && ...)',
		' ┃ ● Bash(printf a > sub.txt…)',
		' ┃ ● Bash(printf a > sub.txt',
	]) {
		const cut = agySubagentBannerScreen('self', 'Bash', [callLine]);
		expect(cut.permission?.cutOff, callLine).toBe(true);
	}

	expect(
		parseAgySubagentManageApproval(agentScreenFixture('agy-subagent-manage')),
	).toStrictEqual({
		cursor: 1,
		denyNumber: 2,
		tool: 'qastub/qa_echo',
		rawTool: 'qastub/qa_echo',
		command: '{"text":"sub-1"}',
	});
	expect(parseAgySubagentManageApproval('no approval section')).toBe(null);
});

test('agy permission parser resists inner rules, rejects unknown headers, guards wrapped paths, and bounds MCP/config scans', () => {
	// A `────────` line inside a heredoc must not shift the Command header into the body.
	const commandOptions = ['> 1. Yes, run command', '  2. No, cancel'];
	const heredocWithRule = agyPermissionScreen({
		header: 'Command',
		body: [
			'Requesting permission for:',
			'   cat <<EOF',
			'   ────────────────────',
			'   doctl account get',
			'   EOF',
		],
		question: 'Run this command?',
		options: commandOptions,
		footer: '  ↑/↓ Navigate · tab Amend',
	});
	expect(heredocWithRule.permission).toMatchObject({
		tool: 'Bash command',
		command: 'cat <<EOF\n────────────────────\ndoctl account get\nEOF',
		source: 'agy',
		cutOff: false,
	});

	// Fake `File access\n────\nRead: /wt/a` inside a Command body (indented or
	// column-0) must never spoof a Read file prompt.
	for (const indent of ['   ', '']) {
		const spoofed = agyPermissionScreen({
			header: 'Command',
			body: [
				'Requesting permission for:',
				'   cat <<EOF',
				`${indent}File access`,
				`${indent}────────────────────`,
				`${indent}Read: /wt/a`,
				'   EOF',
			],
			question: 'Run this command?',
			options: commandOptions,
			footer: '  ↑/↓ Navigate · tab Amend',
		});
		expect(
			spoofed.permission,
			`indent=${JSON.stringify(indent)}`,
		).toMatchObject({
			tool: 'Bash command',
			command: 'cat <<EOF\nFile access\n────────────────────\nRead: /wt/a\nEOF',
			source: 'agy',
			cutOff: false,
		});
	}

	// Unknown permission header fails closed (permission: null) so OSC blocked holds it safely.
	const unknownHeader = agyPermissionScreen({
		header: 'Custom tool',
		body: ['something'],
		question: 'Allow this?',
		options: ['> 1. Yes, approve', '  2. No, deny'],
	});
	expect(unknownHeader.permission).toBe(null);

	// Wrapped File access or Create file path leaves filePath undefined so policy holds.
	const wrappedRead = agyPermissionScreen({
		header: 'File access',
		body: [
			'Read: /tmp/q-agy-d/home/.worktrees/qagy-d/qa-b2/very/long',
			'/path/outside.txt',
		],
		question: 'Allow access to this file?',
		options: ['> 1. Yes, allow access', '  2. No, deny access'],
	});
	expect(wrappedRead.permission).toMatchObject({tool: 'Read file'});
	expect(wrappedRead.permission?.filePath).toBeUndefined();

	const wrappedCreate = agyPermissionScreen({
		header: 'Create file',
		body: [
			'/tmp/q-agy-d/home/.worktrees/qagy-d/qa-b2/long',
			'/continuation.txt  +1',
			'  1  +  hi',
		],
		question: 'Allow creation of this file?',
		options: ['> 1. Yes, allow creation', '  2. No, deny creation'],
		footer: '  ↑/↓ Navigate · f full diff',
	});
	expect(wrappedCreate.permission?.filePath).toBeUndefined();

	// MCP scan stops at the user's prompt line and flags truncated `...)` args.
	const mcpOptions = ['> 1. Yes, allow tool call', '  2. No, deny tool call'];
	const mcpPreviousTurn = agyPermissionScreen({
		above: [
			'● qastub/qa_echo({"text":"old-turn"}) (ctrl+o to expand)',
			'> Call qa_echo again',
			'',
		],
		header: 'MCP',
		body: ['qastub/qa_echo'],
		question: 'Allow calling this tool?',
		options: mcpOptions,
		footer: '  ↑/↓ Navigate · tab Amend',
	});
	expect(mcpPreviousTurn.permission?.command).toBe('qastub/qa_echo');
	expect(mcpPreviousTurn.permission?.cutOff).toBe(true);

	const mcpTruncated = agyPermissionScreen({
		above: ['● qastub/qa_echo({"text":"cut...) (ctrl+o to expand)', ''],
		header: 'MCP',
		body: ['qastub/qa_echo'],
		question: 'Allow calling this tool?',
		options: mcpOptions,
		footer: '  ↑/↓ Navigate · tab Amend',
	});
	expect(mcpTruncated.permission?.cutOff).toBe(true);

	// Expanded `/config` submenu (`enter Save  esc Cancel`) parses as config,
	// while scrollback `Settings` above the composer does not false-match.
	const expandedConfig = parseAgentScreen(
		[
			'────────────────────────────────────────',
			'>',
			'────────────────────────────────────────',
			'Settings',
			'  Agent Mode',
			'  > auto (current)',
			'    plan',
			'',
			'Keyboard: ↑/↓ Navigate  enter Save  esc Cancel',
			'auto · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(expandedConfig.agyDialog).toBe('config');
	expect(expandedConfig.composer).toBe(null);

	const scrollbackSettings = parseAgentScreen(
		[
			'Settings',
			'> some prompt',
			'Keyboard: ↑/↓ Navigate  enter Save  esc Cancel',
			'auto · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(scrollbackSettings.agyDialog).toBe(null);
});

test('agy Models & Quota panel, Refreshes in durations, and AI credits exhaustion parse cleanly', () => {
	expect(parseResetTime('Refreshes in 4h 58m', NOW)).toStrictEqual(
		new Date(NOW.getTime() + (4 * 60 + 58) * 60_000),
	);
	expect(parseResetTime('Refreshes in 6d 18h 55m', NOW)).toStrictEqual(
		new Date(NOW.getTime() + ((6 * 24 + 18) * 60 + 55) * 60_000),
	);
	expect(parseResetTime('Refreshes in 2h', NOW)).toStrictEqual(
		new Date(NOW.getTime() + 2 * 3600_000),
	);
	expect(parseResetTime('Refreshes in 45m', NOW)).toStrictEqual(
		new Date(NOW.getTime() + 45 * 60_000),
	);
	expect(parseResetTime('4h 58m', NOW)).toStrictEqual(
		new Date(NOW.getTime() + (4 * 60 + 58) * 60_000),
	);

	// Healthy open Models & Quota panel parses as agyDialog: 'quota_panel' (not codexDialog, not usage_limit).
	const healthy = screen('agy-quota-panel');
	expect(healthy.agyDialog).toBe('quota_panel');
	expect(healthy.codexDialog).toBe(null);
	expect(healthy.composer).toBe(null);
	expect(healthy.usageLimit).toBe(null);
	expect(classifyAgent(null, healthy)).toBe('dialog');

	// Exhausted Models & Quota panel parses as usage_limit while keeping agyDialog: 'quota_panel'.
	const exhausted = screen('agy-quota-panel-exhausted');
	expect(exhausted.agyDialog).toBe('quota_panel');
	expect(exhausted.codexDialog).toBe(null);
	expect(exhausted.usageLimit).toStrictEqual({
		resetText: 'Refreshes in 4h 58m',
		resetAt: new Date(NOW.getTime() + (4 * 60 + 58) * 60_000),
		passed: false,
	});
	expect(classifyAgent(null, exhausted)).toBe('usage_limit');

	// Credit exhaustion error on agy screen without the quota panel still classifies as usage_limit.
	const creditsOnly = parseAgentScreen(
		[
			'  Your AI credits balance is too low to continue',
			'────────────────────────────────────────',
			'\u001B[94m>\u001B[39m',
			'────────────────────────────────────────',
			'? for shortcuts    auto · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(creditsOnly.usageLimit).toStrictEqual({
		resetText: '',
		resetAt: null,
		passed: false,
	});
	expect(classifyAgent(null, creditsOnly)).toBe('usage_limit');

	// Credits error above a healthy Models & Quota panel does NOT steal a healthy bucket's refresh time.
	const creditsWithHealthyPanel = parseAgentScreen(
		`  Your AI credits balance is too low to continue\n${agentScreenFixture('agy-quota-panel')}`,
		NOW,
	);
	expect(creditsWithHealthyPanel.agyDialog).toBe('quota_panel');
	expect(creditsWithHealthyPanel.usageLimit).toStrictEqual({
		resetText: '',
		resetAt: null,
		passed: false,
	});
	expect(classifyAgent(null, creditsWithHealthyPanel)).toBe('usage_limit');

	// A depleted bucket without its own refresh line does NOT steal the next bucket's refresh line.
	const noCrossBucketBleed = parseAgentScreen(
		[
			'└ Models & Quota',
			'GEMINI MODELS',
			'  Weekly Limit Remaining',
			'    [░░░░░░░░░░] 0% (Quota exhausted)',
			'  Five Hour Limit Remaining',
			'    [██████████] 80%',
			'    Refreshes in 2h 15m',
			'  ↑/↓ Scroll · esc Close',
			'auto · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(noCrossBucketBleed.usageLimit).toStrictEqual({
		resetText: '',
		resetAt: null,
		passed: false,
	});

	// A 0% bar at EOL without the literal "Quota exhausted" text still parses usageLimit.
	const bareZeroPercent = parseAgentScreen(
		[
			'└ Models & Quota',
			'GEMINI MODELS',
			'  Five Hour Limit Remaining',
			'    [░░░░░░░░░░] 0%',
			'    Refreshes in 1h 20m',
			'  ↑/↓ Scroll · esc Close',
			'auto · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(bareZeroPercent.usageLimit).toStrictEqual({
		resetText: 'Refreshes in 1h 20m',
		resetAt: new Date(NOW.getTime() + 80 * 60_000),
		passed: false,
	});

	// Indented reply text mentioning `Error: ... rate limit` must NOT trigger usage_limit;
	// column-0 `Error: rate limit exceeded` still does.
	const composerLines = [
		'────────────────────────────────────────',
		'\u001B[94m>\u001B[39m',
		'────────────────────────────────────────',
		'? for shortcuts    auto · Gemini 4 Hydrogen · medium',
	];
	const indentedReply = parseAgentScreen(
		['  Error: GitHub API rate limit exceeded', ...composerLines].join('\n'),
		NOW,
	);
	expect(indentedReply.usageLimit).toBe(null);
	expect(classifyAgent(null, indentedReply)).toBe('idle');

	const col0Error = parseAgentScreen(
		['Error: rate limit exceeded', ...composerLines].join('\n'),
		NOW,
	);
	expect(col0Error.usageLimit).toStrictEqual({
		resetText: '',
		resetAt: null,
		passed: false,
	});
	expect(classifyAgent(null, col0Error)).toBe('usage_limit');
});
