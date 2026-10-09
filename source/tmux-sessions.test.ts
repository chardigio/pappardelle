import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {
	getSessionNames,
	extractIssueKeyFromSession,
	getSessionPrefix,
	getLegacyAgentSessionPrefix,
	pretrustDirectoryForClaude,
	buildAgentResumeCommand,
} from './tmux.ts';
import {
	bindResumeArgs,
	DEFAULT_RESOLVED_AGENT_PROFILE,
	type ResolvedAgentProfile,
} from './config.ts';

// The built-in claude agent profile once the space has a recorded session.
const resumingClaude: ResolvedAgentProfile = {
	...DEFAULT_RESOLVED_AGENT_PROFILE,
	resumeArgs: bindResumeArgs(DEFAULT_RESOLVED_AGENT_PROFILE, 'sess-1'),
};

// getSessionPrefix: returns repo-qualified prefix
test('getSessionPrefix includes repo name for agent', t => {
	const prefix = getSessionPrefix('agent', 'pappa-chex');
	t.is(prefix, 'agent-pappa-chex-');
});

test('getSessionPrefix includes repo name for companion', t => {
	const prefix = getSessionPrefix('companion', 'pappa-chex');
	t.is(prefix, 'companion-pappa-chex-');
});

test('getLegacyAgentSessionPrefix keeps the legacy claude prefix', t => {
	t.is(getLegacyAgentSessionPrefix('pappa-chex'), 'claude-pappa-chex-');
});

// getSessionNames: repo-qualified session names
test('getSessionNames qualifies issue key with repo name', t => {
	const names = getSessionNames('CHEX-313', 'pappa-chex');
	t.is(names.agent, 'agent-pappa-chex-CHEX-313');
	t.is(names.companion, 'companion-pappa-chex-CHEX-313');
});

test('getSessionNames qualifies main branch with repo name', t => {
	const names = getSessionNames('main', 'pappa-chex');
	t.is(names.agent, 'agent-pappa-chex-main');
	t.is(names.companion, 'companion-pappa-chex-main');
});

test('getSessionNames works with different repo names', t => {
	const names = getSessionNames('STA-100', 'stardust-labs');
	t.is(names.agent, 'agent-stardust-labs-STA-100');
	t.is(names.companion, 'companion-stardust-labs-STA-100');
});

// extractIssueKeyFromSession: strips repo-qualified prefix
test('extractIssueKeyFromSession strips repo prefix from agent session', t => {
	t.is(
		extractIssueKeyFromSession('agent-pappa-chex-CHEX-313', 'pappa-chex'),
		'CHEX-313',
	);
});

test('extractIssueKeyFromSession strips repo prefix from main session', t => {
	t.is(
		extractIssueKeyFromSession('agent-pappa-chex-main', 'pappa-chex'),
		'main',
	);
});

test('extractIssueKeyFromSession returns null for non-matching session', t => {
	t.is(
		extractIssueKeyFromSession('agent-other-repo-STA-100', 'pappa-chex'),
		null,
	);
});

test('extractIssueKeyFromSession returns null for bare agent prefix', t => {
	t.is(extractIssueKeyFromSession('agent-CHEX-313', 'pappa-chex'), null);
});

test('extractIssueKeyFromSession returns null for legacy claude prefix', t => {
	t.is(
		extractIssueKeyFromSession('claude-pappa-chex-CHEX-313', 'pappa-chex'),
		null,
	);
});

// pretrustDirectoryForClaude: workspace trust management

function makeTempConfigPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'pretrust-test-'));
	return join(dir, '.claude.json');
}

test('pretrustDirectoryForClaude creates config with trust entry when file does not exist', t => {
	const configPath = makeTempConfigPath();
	pretrustDirectoryForClaude('/tmp/worktree/STA-100', configPath);
	const config = JSON.parse(readFileSync(configPath, 'utf-8'));
	t.deepEqual(config.projects['/tmp/worktree/STA-100'], {
		hasTrustDialogAccepted: true,
	});
});

test('pretrustDirectoryForClaude adds trust entry without clobbering existing config', t => {
	const configPath = makeTempConfigPath();
	const existing = {
		someOtherSetting: 'keep-me',
		projects: {
			'/existing/path': {hasTrustDialogAccepted: true, customSetting: 42},
		},
	};
	writeFileSync(configPath, JSON.stringify(existing));

	pretrustDirectoryForClaude('/tmp/worktree/STA-200', configPath);

	const config = JSON.parse(readFileSync(configPath, 'utf-8'));
	t.is(config.someOtherSetting, 'keep-me');
	t.deepEqual(config.projects['/existing/path'], {
		hasTrustDialogAccepted: true,
		customSetting: 42,
	});
	t.deepEqual(config.projects['/tmp/worktree/STA-200'], {
		hasTrustDialogAccepted: true,
	});
});

test('pretrustDirectoryForClaude is idempotent when path already trusted', t => {
	const configPath = makeTempConfigPath();
	const existing = {
		projects: {
			'/already/trusted': {hasTrustDialogAccepted: true},
		},
	};
	writeFileSync(configPath, JSON.stringify(existing));

	pretrustDirectoryForClaude('/already/trusted', configPath);

	// File should not have been rewritten (content unchanged)
	const config = JSON.parse(readFileSync(configPath, 'utf-8'));
	t.deepEqual(config.projects['/already/trusted'], {
		hasTrustDialogAccepted: true,
	});
});

test('pretrustDirectoryForClaude handles corrupt JSON gracefully', t => {
	const configPath = makeTempConfigPath();
	writeFileSync(configPath, 'this is not valid json{{{');

	// Should not throw — falls back to fresh config
	t.notThrows(() => {
		pretrustDirectoryForClaude('/tmp/worktree/STA-300', configPath);
	});

	const config = JSON.parse(readFileSync(configPath, 'utf-8'));
	t.deepEqual(config.projects['/tmp/worktree/STA-300'], {
		hasTrustDialogAccepted: true,
	});
});

// buildAgentResumeCommand: generates the resume-then-launch fallback chain.
// Without an agent profile argument the output must stay byte-identical to the
// claude command from before agent profiles — these assertions pin that.

test('buildAgentResumeCommand resumes the recorded session first', t => {
	const cmd = buildAgentResumeCommand('STA-806', false, {}, resumingClaude);
	t.true(cmd.startsWith('claude --name STA-806 --resume sess-1'));
});

test('buildAgentResumeCommand falls back to bare claude with --name', t => {
	const cmd = buildAgentResumeCommand('STA-806', false, {}, resumingClaude);
	t.true(cmd.endsWith('|| claude --name STA-806'));
});

test('buildAgentResumeCommand includes ANSI escape to clear error line', t => {
	const cmd = buildAgentResumeCommand('STA-806', false, {}, resumingClaude);
	t.true(cmd.includes("printf '\\033[A\\033[2K'"));
});

// Spaces whose sessions predate id recording have nothing recorded, and
// claude's --continue only looks in the space's own directory.
test('buildAgentResumeCommand without a recorded session continues claude', t => {
	t.is(
		buildAgentResumeCommand('STA-806'),
		"claude --name STA-806 --continue || { printf '\\033[A\\033[2K'; false; } || claude --name STA-806",
	);
});

// A literal {session_id} would reach the agent as a session name and fail, and
// codex's directory-agnostic `resume --last` would find another space's.
test('buildAgentResumeCommand without a recorded session launches other agents directly', t => {
	const codex: ResolvedAgentProfile = {
		name: 'codex',
		command: 'codex',
		args: '',
		resumeArgs: 'resume {session_id}',
		isClaude: false,
	};
	t.is(buildAgentResumeCommand('STA-806', false, {}, codex), 'codex');
});

test('buildAgentResumeCommand with skipPermissions includes flag in both branches', t => {
	const cmd = buildAgentResumeCommand('STA-806', true, {}, resumingClaude);
	// resume attempt should have both flags
	t.true(
		cmd.startsWith(
			'claude --dangerously-skip-permissions --name STA-806 --resume sess-1',
		),
	);
	// Fallback should also have both flags
	t.true(
		cmd.endsWith('|| claude --dangerously-skip-permissions --name STA-806'),
	);
});

test('buildAgentResumeCommand without skipPermissions has no permission flag', t => {
	const cmd = buildAgentResumeCommand('STA-806', false);
	t.false(cmd.includes('--dangerously-skip-permissions'));
});

test('buildAgentResumeCommand default is skipPermissions=false', t => {
	t.is(
		buildAgentResumeCommand('STA-806'),
		buildAgentResumeCommand('STA-806', false),
	);
});

test('buildAgentResumeCommand sets --name to the issue key on both branches', t => {
	const cmd = buildAgentResumeCommand('CHEX-42', false, {}, resumingClaude);
	// --name appears in both the resume attempt and the fallback
	const occurrences = cmd.match(/--name CHEX-42/g) ?? [];
	t.is(occurrences.length, 2);
});

test('buildAgentResumeCommand shell-quotes non-standard issue keys', t => {
	// An issue key with shell metacharacters should be safely quoted.
	const cmd = buildAgentResumeCommand(
		'weird key; rm -rf /',
		false,
		{},
		resumingClaude,
	);
	// Must not contain the raw unquoted metacharacters inline as an arg.
	t.false(cmd.includes('--name weird key; rm -rf /'));
	// Must still reference --name twice.
	t.is((cmd.match(/--name /g) ?? []).length, 2);
});

// Session-name encoding for beads' hierarchical IDs
test('getSessionNames encodes the dot in a beads child ID', t => {
	// tmux rewrites '.' to '_' in session names, so a raw name could never be
	// found again by has-session, and a space that always looks absent gets
	// respawned forever.
	const names = getSessionNames('bd-a3f8e9.1', 'pappa');
	t.is(names.agent, 'agent-pappa-bd-a3f8e9_1');
	t.is(names.companion, 'companion-pappa-bd-a3f8e9_1');
});

test('extractIssueKeyFromSession decodes a beads child ID', t => {
	t.is(
		extractIssueKeyFromSession('agent-pappa-bd-a3f8e9_1', 'pappa'),
		'bd-a3f8e9.1',
	);
});

test('session-name encoding survives an underscore in the key', t => {
	// A beads prefix defaults to the repo directory name, so my_service-a1b2 is
	// an ordinary ID. Decoding every '_' to '.' would hand back my.service-a1b2.
	const {agent} = getSessionNames('my_service-a1b2', 'pappa');
	t.is(agent, 'agent-pappa-my__service-a1b2');
	t.is(extractIssueKeyFromSession(agent, 'pappa'), 'my_service-a1b2');
});

test('session-name encoding round-trips every tracker key shape', t => {
	for (const key of [
		'STA-123',
		'bd-a1b2',
		'bd-a3f8e9.1',
		'bd-a3f8e9.1.2',
		'my_service-a1b2',
		'my_service-a3f8e9.1',
	]) {
		const {agent} = getSessionNames(key, 'pappa');
		t.is(extractIssueKeyFromSession(agent, 'pappa'), key);
	}
});

// buildAgentResumeCommand: non-claude agents

const codexAgentProfile: ResolvedAgentProfile = {
	name: 'codex',
	command: 'codex',
	args: '--yolo',
	resumeArgs: 'resume --last',
	isClaude: false,
};

test('non-claude agent with resume args gets the fallback chain', t => {
	const cmd = buildAgentResumeCommand('STA-1', false, {}, codexAgentProfile);
	t.is(
		cmd,
		"codex --yolo resume --last || { printf '\\033[A\\033[2K'; false; } || codex --yolo",
	);
});

test('non-claude agent without resume args launches directly', t => {
	const cmd = buildAgentResumeCommand(
		'STA-1',
		false,
		{},
		{
			...codexAgentProfile,
			resumeArgs: undefined,
		},
	);
	t.is(cmd, 'codex --yolo');
});

// Codex's `resume` is a subcommand, so every flag has to come before it.
test('model and effort flags precede the resume args', t => {
	const cmd = buildAgentResumeCommand(
		'STA-1',
		false,
		{model: 'gpt-5.5', effort: 'high'},
		{
			...codexAgentProfile,
			resumeArgs: 'resume abc',
			modelArgs: '-m {model}',
			effortArgs: '-c model_reasoning_effort={effort}',
		},
	);
	const base = 'codex --yolo -m gpt-5.5 -c model_reasoning_effort=high';
	t.is(
		cmd,
		`${base} resume abc || { printf '\\033[A\\033[2K'; false; } || ${base}`,
	);
});

test('non-claude agent without flag templates gets no --name, dsp, model, or effort flags', t => {
	const cmd = buildAgentResumeCommand(
		'STA-1',
		true,
		{model: 'opus', effort: 'high'},
		codexAgentProfile,
	);
	t.false(cmd.includes('--name'));
	t.false(cmd.includes('--dangerously-skip-permissions'));
	t.false(cmd.includes('--model'));
	t.false(cmd.includes('--effort'));
});

test('empty-string resume args also launch directly (no malformed chain)', t => {
	// getAgentProfile never emits '' (it normalizes to undefined), but the
	// builder guards on falsy too so a hand-built ResolvedAgentProfile can't produce
	// a `base  || … || base` double-launch chain.
	const cmd = buildAgentResumeCommand(
		'STA-1',
		false,
		{},
		{
			...codexAgentProfile,
			resumeArgs: '',
		},
	);
	t.is(cmd, 'codex --yolo');
});

test('non-claude agent without args uses the bare command', t => {
	const cmd = buildAgentResumeCommand(
		'STA-1',
		false,
		{},
		{
			name: 'codex',
			command: 'codex',
			args: '',
			resumeArgs: undefined,
			isClaude: false,
		},
	);
	t.is(cmd, 'codex');
});

// buildAgentResumeCommand: claude-gating agent profiles (is_claude override)

test('claude agent profile passed explicitly matches the default output', t => {
	const claudeAgentProfile: ResolvedAgentProfile = {
		name: 'claude',
		command: 'claude',
		args: '',
		resumeArgs: '--resume {session_id}',
		isClaude: true,
	};
	t.is(
		buildAgentResumeCommand('STA-806', false, {}, claudeAgentProfile),
		buildAgentResumeCommand('STA-806'),
	);
});

test('claude-gated wrapper gets the full claude treatment under its own command', t => {
	const wrapper: ResolvedAgentProfile = {
		...DEFAULT_RESOLVED_AGENT_PROFILE,
		name: 'claude-local',
		command: 'claude-local',
		resumeArgs: '--continue',
	};
	const cmd = buildAgentResumeCommand(
		'STA-806',
		true,
		{model: 'opus'},
		wrapper,
	);
	t.true(
		cmd.startsWith(
			'claude-local --dangerously-skip-permissions --model opus --name STA-806 --continue',
		),
	);
});

test('claude-gated agent args slot between dsp and model flags', t => {
	const shadowed: ResolvedAgentProfile = {
		...DEFAULT_RESOLVED_AGENT_PROFILE,
		args: '--verbose',
		resumeArgs: '--continue',
	};
	const cmd = buildAgentResumeCommand(
		'STA-806',
		true,
		{model: 'opus'},
		shadowed,
	);
	t.true(
		cmd.startsWith(
			'claude --dangerously-skip-permissions --verbose --model opus --name STA-806 --continue',
		),
	);
});
