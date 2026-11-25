import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sessionNamesFor, sessionPrefix} from './space-identity.ts';
import {test, expect} from 'bun:test';
import {pretrustDirectoryForClaude, buildAgentResumeCommand} from './tmux.ts';
import {
	DEFAULT_RESOLVED_AGENT_PROFILE,
	type ResolvedAgentProfile,
} from './config.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';

// sessionPrefix: returns repo-qualified prefix
test('sessionPrefix includes repo name for agent', () => {
	const prefix = sessionPrefix('agent', 'pappa-chex');
	expect(prefix).toBe('agent-pappa-chex-');
});

test('sessionPrefix includes repo name for companion', () => {
	const prefix = sessionPrefix('companion', 'pappa-chex');
	expect(prefix).toBe('companion-pappa-chex-');
});

// getSessionNames: repo-qualified session names
test('getSessionNames qualifies issue key with repo name', () => {
	const names = sessionNamesFor('CHEX-313', 'pappa-chex');
	expect(names.agent).toBe('agent-pappa-chex-CHEX-313');
	expect(names.companion).toBe('companion-pappa-chex-CHEX-313');
});

test('getSessionNames qualifies main branch with repo name', () => {
	const names = sessionNamesFor('main', 'pappa-chex');
	expect(names.agent).toBe('agent-pappa-chex-main');
	expect(names.companion).toBe('companion-pappa-chex-main');
});

test('getSessionNames works with different repo names', () => {
	const names = sessionNamesFor('STA-100', 'stardust-labs');
	expect(names.agent).toBe('agent-stardust-labs-STA-100');
	expect(names.companion).toBe('companion-stardust-labs-STA-100');
});

// pretrustDirectoryForClaude: workspace trust management

function makeTempConfigPath(): string {
	return join(tempDir('pretrust-test-'), '.claude.json');
}

test('pretrustDirectoryForClaude creates config with trust entry when file does not exist', () => {
	const configPath = makeTempConfigPath();
	pretrustDirectoryForClaude('/tmp/worktree/STA-100', configPath);
	const config = JSON.parse(readFileSync(configPath, 'utf-8'));
	expect(config.projects['/tmp/worktree/STA-100']).toStrictEqual({
		hasTrustDialogAccepted: true,
	});
});

test('pretrustDirectoryForClaude adds trust entry without clobbering existing config', () => {
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
	expect(config.someOtherSetting).toBe('keep-me');
	expect(config.projects['/existing/path']).toStrictEqual({
		hasTrustDialogAccepted: true,
		customSetting: 42,
	});
	expect(config.projects['/tmp/worktree/STA-200']).toStrictEqual({
		hasTrustDialogAccepted: true,
	});
});

test('pretrustDirectoryForClaude is idempotent when path already trusted', () => {
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
	expect(config.projects['/already/trusted']).toStrictEqual({
		hasTrustDialogAccepted: true,
	});
});

test('pretrustDirectoryForClaude handles corrupt JSON gracefully', () => {
	const configPath = makeTempConfigPath();
	writeFileSync(configPath, 'this is not valid json{{{');

	// Should not throw — falls back to fresh config
	expect(() => {
		pretrustDirectoryForClaude('/tmp/worktree/STA-300', configPath);
	}).not.toThrow();

	const config = JSON.parse(readFileSync(configPath, 'utf-8'));
	expect(config.projects['/tmp/worktree/STA-300']).toStrictEqual({
		hasTrustDialogAccepted: true,
	});
});

// buildAgentResumeCommand: generates the resume-then-launch fallback chain.
// Without an agent profile argument the output must stay byte-identical to the
// claude command from before agent profiles — these assertions pin that.

test('buildAgentResumeCommand resumes the recorded session first', () => {
	const cmd = buildAgentResumeCommand(
		'STA-806',
		false,
		DEFAULT_RESOLVED_AGENT_PROFILE,
		'sess-1',
	);
	expect(cmd.startsWith('claude --name STA-806 --resume sess-1')).toBe(true);
});

test('buildAgentResumeCommand falls back to bare claude with --name', () => {
	const cmd = buildAgentResumeCommand(
		'STA-806',
		false,
		DEFAULT_RESOLVED_AGENT_PROFILE,
		'sess-1',
	);
	expect(cmd.endsWith('|| claude --name STA-806')).toBe(true);
});

test('buildAgentResumeCommand includes ANSI escape to clear error line', () => {
	const cmd = buildAgentResumeCommand(
		'STA-806',
		false,
		DEFAULT_RESOLVED_AGENT_PROFILE,
		'sess-1',
	);
	expect(cmd.includes("printf '\\033[A\\033[2K'")).toBe(true);
});

// Spaces whose sessions predate id recording have nothing recorded, and
// claude's --continue only looks in the space's own directory.
test('buildAgentResumeCommand without a recorded session continues claude', () => {
	expect(buildAgentResumeCommand('STA-806')).toBe(
		"claude --name STA-806 --continue || { printf '\\033[A\\033[2K'; false; } || claude --name STA-806",
	);
});

// A literal {session_id} would reach the agent as a session name and fail, and
// codex's directory-agnostic `resume --last` would find another space's.
test('buildAgentResumeCommand without a recorded session launches other agents directly', () => {
	const codex: ResolvedAgentProfile = {
		name: 'codex',
		command: 'codex',
		args: '',
		resumeArgs: 'resume {session_id}',
		isClaude: false,
		model: '',
		effort: '',
		mode: '',
		extraArgs: [],
		skillPrefix: '$',
		supportsSousChefPrompt: true,
		rulesArgs: [],
		env: {},
	};
	expect(buildAgentResumeCommand('STA-806', false, codex)).toBe(`codex`);
});

test('buildAgentResumeCommand with skipPermissions includes flag in both branches', () => {
	const cmd = buildAgentResumeCommand(
		'STA-806',
		true,
		DEFAULT_RESOLVED_AGENT_PROFILE,
		'sess-1',
	);
	// resume attempt should have both flags
	expect(
		cmd.startsWith(
			'claude --dangerously-skip-permissions --name STA-806 --resume sess-1',
		),
	).toBe(true);
	// Fallback should also have both flags
	expect(
		cmd.endsWith('|| claude --dangerously-skip-permissions --name STA-806'),
	).toBe(true);
});

test('buildAgentResumeCommand without skipPermissions has no permission flag', () => {
	const cmd = buildAgentResumeCommand('STA-806', false);
	expect(cmd.includes('--dangerously-skip-permissions')).toBe(false);
});

test('buildAgentResumeCommand default is skipPermissions=false', () => {
	expect(buildAgentResumeCommand('STA-806')).toBe(
		buildAgentResumeCommand('STA-806', false),
	);
});

test('buildAgentResumeCommand sets --name to the issue key on both branches', () => {
	const cmd = buildAgentResumeCommand(
		'CHEX-42',
		false,
		DEFAULT_RESOLVED_AGENT_PROFILE,
		'sess-1',
	);
	// --name appears in both the resume attempt and the fallback
	const occurrences = cmd.match(/--name CHEX-42/g) ?? [];
	expect(occurrences.length).toBe(2);
});

test('buildAgentResumeCommand shell-quotes non-standard issue keys', () => {
	// An issue key with shell metacharacters should be safely quoted.
	const cmd = buildAgentResumeCommand(
		'weird key; rm -rf /',
		false,
		DEFAULT_RESOLVED_AGENT_PROFILE,
		'sess-1',
	);
	// Must not contain the raw unquoted metacharacters inline as an arg.
	expect(cmd.includes('--name weird key; rm -rf /')).toBe(false);
	// Must still reference --name twice.
	expect((cmd.match(/--name /g) ?? []).length).toBe(2);
});

// Session-name encoding for beads' hierarchical IDs
test('getSessionNames encodes the dot in a beads child ID', () => {
	// tmux rewrites '.' to '_' in session names, so a raw name could never be
	// found again by has-session, and a space that always looks absent gets
	// respawned forever.
	const names = sessionNamesFor('bd-a3f8e9.1', 'pappa');
	expect(names.agent).toBe('agent-pappa-bd-a3f8e9_1');
	expect(names.companion).toBe('companion-pappa-bd-a3f8e9_1');
});

test('session-name encoding survives an underscore in the key', () => {
	// A beads prefix defaults to the repo directory name, so my_service-a1b2 is
	// an ordinary ID. Decoding every '_' to '.' would hand back my.service-a1b2.
	const {agent} = sessionNamesFor('my_service-a1b2', 'pappa');
	expect(agent).toBe('agent-pappa-my__service-a1b2');
});

test('every tracker key shape gets a session name of its own', () => {
	// Two spaces sharing a name would share their sessions, and the identity
	// store refuses the second.
	const keys = [
		'STA-123',
		'bd-a1b2',
		'bd-a3f8e9.1',
		'bd-a3f8e9_1',
		'bd-a3f8e9.1.2',
		'my_service-a1b2',
		'my.service-a1b2',
		'my_service-a3f8e9.1',
	];
	const names = new Set(keys.map(key => sessionNamesFor(key, 'pappa').agent));
	expect(names.size).toBe(keys.length);
});

// buildAgentResumeCommand: non-claude agents

const codexAgentProfile: ResolvedAgentProfile = {
	name: 'codex',
	command: 'codex',
	args: '--yolo',
	resumeArgs: 'resume --last',
	isClaude: false,
	model: '',
	effort: '',
	mode: '',
	extraArgs: [],
	skillPrefix: '$',
	supportsSousChefPrompt: true,
	rulesArgs: [],
	env: {},
};

test('non-claude agent with resume args gets the fallback chain', () => {
	const cmd = buildAgentResumeCommand('STA-1', false, codexAgentProfile);
	expect(cmd).toBe(
		`codex --yolo resume --last || { printf '\\033[A\\033[2K'; false; } || codex --yolo`,
	);
});

test('non-claude agent without resume args launches directly', () => {
	const cmd = buildAgentResumeCommand('STA-1', false, {
		...codexAgentProfile,
		resumeArgs: undefined,
	});
	expect(cmd).toBe(`codex --yolo`);
});

// Codex's `resume` is a subcommand, so every flag has to come before it.
test('model and effort flags precede the resume args', () => {
	const cmd = buildAgentResumeCommand('STA-1', false, {
		...codexAgentProfile,
		resumeArgs: 'resume abc',
		modelArgs: '-m {model}',
		effortArgs: '-c model_reasoning_effort={effort}',
		model: 'gpt-5.5',
		effort: 'high',
	});
	const base = `codex --yolo -m gpt-5.5 -c model_reasoning_effort=high`;
	expect(cmd).toBe(
		`${base} resume abc || { printf '\\033[A\\033[2K'; false; } || ${base}`,
	);
});

test('non-claude agent without flag templates gets no --name, dsp, model, or effort flags', () => {
	const cmd = buildAgentResumeCommand('STA-1', true, {
		...codexAgentProfile,
		model: 'opus',
		effort: 'high',
	});
	expect(cmd.includes('--name')).toBe(false);
	expect(cmd.includes('--dangerously-skip-permissions')).toBe(false);
	expect(cmd.includes('--model')).toBe(false);
	expect(cmd.includes('--effort')).toBe(false);
});

test('empty-string resume args also launch directly (no malformed chain)', () => {
	// getAgentProfile never emits '' (it normalizes to undefined), but the
	// builder guards on falsy too so a hand-built ResolvedAgentProfile can't produce
	// a `base  || … || base` double-launch chain.
	const cmd = buildAgentResumeCommand('STA-1', false, {
		...codexAgentProfile,
		resumeArgs: '',
	});
	expect(cmd).toBe(`codex --yolo`);
});

test('non-claude agent without args uses the bare command', () => {
	const cmd = buildAgentResumeCommand('STA-1', false, {
		name: 'codex',
		command: 'codex',
		args: '',
		resumeArgs: undefined,
		isClaude: false,
		model: '',
		effort: '',
		mode: '',
		extraArgs: [],
		skillPrefix: '$',
		supportsSousChefPrompt: true,
		rulesArgs: [],
		env: {},
	});
	expect(cmd).toBe(`codex`);
});

// buildAgentResumeCommand: claude-gating agent profiles (is_claude override)

test('claude agent profile passed explicitly matches the default output', () => {
	const claudeAgentProfile: ResolvedAgentProfile = {
		name: 'claude',
		command: 'claude',
		args: '',
		resumeArgs: '--resume {session_id}',
		isClaude: true,
		model: '',
		effort: '',
		mode: '',
		extraArgs: [],
		skillPrefix: '/',
		supportsSousChefPrompt: true,
		rulesArgs: [],
		env: {},
	};
	expect(buildAgentResumeCommand('STA-806', false, claudeAgentProfile)).toBe(
		buildAgentResumeCommand('STA-806'),
	);
});

test('claude-gated wrapper gets the full claude treatment under its own command', () => {
	const wrapper: ResolvedAgentProfile = {
		...DEFAULT_RESOLVED_AGENT_PROFILE,
		name: 'claude-local',
		command: 'claude-local',
		resumeArgs: '--continue',
	};
	const cmd = buildAgentResumeCommand('STA-806', true, {
		...wrapper,
		model: 'opus',
	});
	expect(
		cmd.startsWith(
			'claude-local --dangerously-skip-permissions --model opus --name STA-806 --continue',
		),
	).toBe(true);
});

test('claude-gated agent args slot between dsp and model flags', () => {
	const shadowed: ResolvedAgentProfile = {
		...DEFAULT_RESOLVED_AGENT_PROFILE,
		args: '--verbose',
		resumeArgs: '--continue',
	};
	const cmd = buildAgentResumeCommand('STA-806', true, {
		...shadowed,
		model: 'opus',
	});
	expect(
		cmd.startsWith(
			'claude --dangerously-skip-permissions --verbose --model opus --name STA-806 --continue',
		),
	).toBe(true);
});
