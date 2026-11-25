import {test, expect} from 'bun:test';
import {
	bindResumeArgs,
	builtinAgentDefaults,
	isClaudeCommand,
	renderAgentLaunchFlags,
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
});

test('isClaudeCommand matches bare names and paths, not wrappers', () => {
	expect(isClaudeCommand('claude')).toBe(true);
	expect(isClaudeCommand('/usr/local/bin/claude')).toBe(true);
	expect(isClaudeCommand('claude --some-flag')).toBe(true);
	expect(isClaudeCommand('codex')).toBe(false);
	expect(isClaudeCommand('claude-local')).toBe(false);
	expect(isClaudeCommand('my-claude-wrapper')).toBe(false);
});

test('builtinAgentDefaults unwraps env wrappers for built-in agents like agy', () => {
	const bare = builtinAgentDefaults({command: 'agy'});
	const wrapped = builtinAgentDefaults({
		command: 'env FOO=1 /usr/local/bin/agy --flag',
	});
	expect(wrapped).toStrictEqual(bare);
	expect(wrapped.prompt_args).toBeTruthy();
});
