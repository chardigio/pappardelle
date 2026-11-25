import {test, expect} from 'bun:test';
import {
	bindResumeArgs,
	builtinAgentDefaults,
	isAgyAgentProfile,
	isAgyCommand,
	isClaudeCommand,
	renderAgentLaunchFlags,
	renderAgentPrompt,
	supportsSousChefPrompt,
	unwrapCommand,
} from './config-launch-flags.ts';

// ============================================================================
// getAgentProfile — resolution
// ============================================================================

const codexResume = {resumeArgs: 'resume {session_id}', isClaude: false};

const claudeResume = {resumeArgs: '--resume {session_id}', isClaude: true};

test('bindResumeArgs fills the recorded session id', () => {
	expect(bindResumeArgs(codexResume, 'abc-123')).toBe('resume abc-123');
	expect(bindResumeArgs(claudeResume, 'abc-123')).toBe('--resume abc-123');
});

test('bindResumeArgs drops the resume attempt without a recorded id', () => {
	expect(bindResumeArgs(codexResume, undefined)).toBe(undefined);
	expect(bindResumeArgs(codexResume, '')).toBe(undefined);
});

test('bindResumeArgs falls back to --continue for claude without a recorded id', () => {
	expect(bindResumeArgs(claudeResume, undefined)).toBe('--continue');
});

test('bindResumeArgs keeps claude flags around the resume when no id was recorded', () => {
	const resume = (resumeArgs: string) =>
		bindResumeArgs({resumeArgs, isClaude: true}, undefined);
	expect(resume('--resume {session_id} --fork-session')).toBe(
		'--continue --fork-session',
	);
	expect(resume('--fork-session --resume={session_id}')).toBe(
		'--fork-session --continue',
	);
	expect(resume('-r {session_id} --fork-session')).toBe(
		'--continue --fork-session',
	);
	// A spelling it can't map still resumes the directory's conversation.
	expect(resume('--from {session_id} --fork-session')).toBe('--continue');
});

test('bindResumeArgs rejects an id that is unsafe to put in a shell command', () => {
	expect(bindResumeArgs(codexResume, 'x; rm -rf ~')).toBe(undefined);
	expect(bindResumeArgs(codexResume, '--yolo')).toBe(undefined);
	expect(bindResumeArgs(claudeResume, '--dangerously-skip-permissions')).toBe(
		'--continue',
	);
});

test('bindResumeArgs leaves resume args without the placeholder alone', () => {
	expect(
		bindResumeArgs({resumeArgs: 'resume --last', isClaude: false}, undefined),
	).toBe('resume --last');
	expect(bindResumeArgs({resumeArgs: undefined, isClaude: true}, 'abc')).toBe(
		undefined,
	);
});

// ============================================================================
// Agent profiles — model and effort
// ============================================================================

test('renderAgentLaunchFlags quotes values that are not bare tokens', () => {
	const codex = {
		modelArgs: '-m {model}',
		effortArgs: '-c model_reasoning_effort={effort}',
	};
	expect(
		renderAgentLaunchFlags({...codex, model: 'gpt-5.5', effort: 'high'}),
	).toBe(' -m gpt-5.5 -c model_reasoning_effort=high');
	expect(
		renderAgentLaunchFlags({
			modelArgs: '--model={model}',
			model: "it's claude-opus-5[1m]",
		}),
	).toBe(` --model='it'\\''s claude-opus-5[1m]'`);
});

test('renderAgentLaunchFlags inserts $ sequences in a value literally', () => {
	expect(
		renderAgentLaunchFlags({modelArgs: '--model {model}', model: 'foo$'}),
	).toBe(` --model 'foo$'`);
	expect(
		renderAgentLaunchFlags({modelArgs: '--model {model}', model: 'a$&b'}),
	).toBe(` --model 'a$&b'`);
});

test('renderAgentLaunchFlags passes no flag without a value or a template', () => {
	expect(renderAgentLaunchFlags({modelArgs: '-m {model}', model: ''})).toBe('');
	expect(renderAgentLaunchFlags({model: 'gpt-5.5', effort: 'high'})).toBe('');
	expect(renderAgentLaunchFlags({modeArgs: '--mode {mode}', mode: ''})).toBe(
		'',
	);
	expect(renderAgentLaunchFlags({mode: 'plan'})).toBe('');
});

test('renderAgentLaunchFlags renders mode through modeArgs after model and effort', () => {
	expect(
		renderAgentLaunchFlags({
			modelArgs: '--model {model}',
			effortArgs: '--effort {effort}',
			modeArgs: '--mode {mode}',
			model: 'gemini-4-hydrogen',
			effort: 'high',
			mode: 'plan',
		}),
	).toBe(' --model gemini-4-hydrogen --effort high --mode plan');
	expect(
		renderAgentLaunchFlags({
			modeArgs: '--mode={mode}',
			mode: 'a b',
		}),
	).toBe(` --mode='a b'`);
});

test('renderAgentPrompt wraps prompt in promptArgs when present and quotes for the shell', () => {
	expect(renderAgentPrompt('/sous-chef')).toBe(` '/sous-chef'`);
	expect(renderAgentPrompt('/sous-chef', '')).toBe(` '/sous-chef'`);
	expect(renderAgentPrompt('/sous-chef', '-i {prompt}')).toBe(
		` -i '/sous-chef'`,
	);
	expect(renderAgentPrompt('$sous-chef')).toBe(` '$sous-chef'`);
	expect(renderAgentPrompt("a'b", '--prompt={prompt}')).toBe(
		` --prompt='a'\\''b'`,
	);
});

test('isClaudeCommand matches bare names and paths, not wrappers', () => {
	expect(isClaudeCommand('claude')).toBe(true);
	expect(isClaudeCommand('/usr/local/bin/claude')).toBe(true);
	expect(isClaudeCommand('claude --some-flag')).toBe(true);
	expect(isClaudeCommand('codex')).toBe(false);
	expect(isClaudeCommand('claude-local')).toBe(false);
	expect(isClaudeCommand('my-claude-wrapper')).toBe(false);
});

test('unwrapCommand, isAgyCommand, and builtinAgentDefaults handle env wrappers', () => {
	expect(
		unwrapCommand('/usr/bin/env -u BAR FOO="1" /usr/local/bin/agy'),
	).toStrictEqual({
		word: '/usr/local/bin/agy',
		env: {FOO: '1'},
		unset: ['BAR'],
	});
	expect(isAgyCommand('env FOO=1 agy --model gemini-4')).toBe(true);
	expect(isAgyCommand('/usr/bin/env -u BAR FOO=1 /usr/local/bin/agy')).toBe(
		true,
	);
	expect(isAgyCommand('FOO=1 agy')).toBe(true);
	expect(isAgyCommand('env FOO=agy codex')).toBe(false);
	expect(isAgyCommand('codex --prompt agy')).toBe(false);

	const bare = builtinAgentDefaults({command: 'agy'});
	const wrapped = builtinAgentDefaults({
		command: 'env FOO=1 /usr/local/bin/agy --flag',
	});
	expect(wrapped).toStrictEqual(bare);
	expect(wrapped.prompt_args).toBeTruthy();
});

test('isAgyAgentProfile matches bare agy and paths unless gated as claude', () => {
	expect(isAgyAgentProfile({command: 'agy'})).toBe(true);
	expect(isAgyAgentProfile({command: '/usr/local/bin/agy --flag'})).toBe(true);
	expect(isAgyAgentProfile({command: 'agy', is_claude: true})).toBe(false);
	expect(isAgyAgentProfile({command: 'claude'})).toBe(false);
	expect(isAgyAgentProfile({command: 'codex'})).toBe(false);
});

test('supportsSousChefPrompt gates prompt to claude, codex, agy, or explicit prompt_args', () => {
	expect(supportsSousChefPrompt({command: 'claude'})).toBe(true);
	expect(
		supportsSousChefPrompt({command: 'claude-local', is_claude: true}),
	).toBe(true);
	expect(supportsSousChefPrompt({command: '/opt/bin/codex'})).toBe(true);
	expect(supportsSousChefPrompt({command: 'agy'})).toBe(true);
	expect(
		supportsSousChefPrompt({command: 'custom', prompt_args: '-i {prompt}'}),
	).toBe(true);
	expect(supportsSousChefPrompt({command: 'opencode', skill_prefix: '/'})).toBe(
		false,
	);
	expect(supportsSousChefPrompt({command: 'pi'})).toBe(false);
	expect(supportsSousChefPrompt({command: 'opencode'})).toBe(false);
	expect(supportsSousChefPrompt({command: 'env FOO=1 agy'})).toBe(false);
	expect(supportsSousChefPrompt({command: 'claude', is_claude: false})).toBe(
		false,
	);
});
