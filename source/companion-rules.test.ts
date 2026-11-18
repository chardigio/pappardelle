import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {
	agentRulesFlags,
	companionRules,
	installAgentRules,
} from './companion-rules.ts';
import {buildAgentResumeCommand} from './tmux.ts';
import {getNamedAgentProfile} from './config.ts';

/** What a shell hands the agent for a launch-flag string. */
function argv(flags: string): string[] {
	const {stdout} = spawnSync('/bin/bash', ['-c', `printf '%s\\0' ${flags}`], {
		encoding: 'utf8',
	});
	return stdout.split('\0').slice(0, -1);
}

function rulesFlagsFor(command: string, isClaude?: boolean): string {
	const definition = {command, is_claude: isClaude};
	return agentRulesFlags(
		getNamedAgentProfile({agent_profiles: {a: definition}}, 'a').rulesArgs,
	);
}

test('the rules survive any shell and a TOML string as they are', t => {
	// Launch lines run in the user's own shell, Nushell and fish included, whose
	// quoting differs for everything except a plain single-quoted string.
	t.notRegex(companionRules(), /['"`$\\]/);
});

test('Codex gets the rules as one -c developer_instructions value', t => {
	const [flag, value, ...rest] = argv(rulesFlagsFor('codex'));
	t.is(flag, '-c');
	t.deepEqual(rest, []);
	t.regex(
		value!,
		/^developer_instructions="[^"\n]*first call companion_run[^"\n]*"$/,
	);
});

test('Pi gets the rules as one --append-system-prompt value', t => {
	const [flag, value, ...rest] = argv(rulesFlagsFor('/opt/bin/pi'));
	t.is(flag, '--append-system-prompt');
	t.deepEqual(rest, []);
	t.notRegex(value!, /\n/);
	t.regex(value!, /first call companion_run/);
});

test('agents that get the rules another way get no flags', t => {
	for (const command of ['claude', 'opencode', 'agy', 'aider']) {
		t.is(rulesFlagsFor(command), '');
	}
});

test('an agent gated as claude takes no rules flag, whatever its command', t => {
	t.is(rulesFlagsFor('codex', true), '');
});

const codexProfile = getNamedAgentProfile(
	{agent_profiles: {codex: {command: 'codex', resume_args: 'resume --last'}}},
	'codex',
);

test("Codex's rules come before the resume subcommand, on both launch paths", t => {
	const command = buildAgentResumeCommand(
		'STA-1',
		false,
		codexProfile,
		undefined,
		{rules: true},
	);
	const rules = rulesFlagsFor('codex');
	t.not(rules, '');
	t.is(
		command,
		`codex${rules} resume --last || { printf '\\033[A\\033[2K'; false; } || codex${rules}`,
	);
});

test('an agent launched without workspace awareness gets no rules', t => {
	t.is(
		buildAgentResumeCommand('STA-1', false, codexProfile),
		"codex resume --last || { printf '\\033[A\\033[2K'; false; } || codex",
	);
});

function worktree(t: ExecutionContext) {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rules-')),
	);
	t.teardown(() => {
		fs.rmSync(root, {recursive: true, force: true});
	});
	const main = path.join(root, 'main');
	const tree = path.join(root, 'tree');
	const git = (cwd: string, ...args: string[]) =>
		spawnSync(
			'git',
			['-c', 'user.email=a@b', '-c', 'user.name=a', '-C', cwd, ...args],
			{encoding: 'utf8'},
		);
	fs.mkdirSync(main);
	git(main, 'init', '--quiet');
	git(main, 'commit', '--quiet', '--allow-empty', '-m', 'init');
	git(main, 'worktree', 'add', '--quiet', tree, '-b', 'tree');
	return {main, tree, git};
}

test('agy gets an always-on rule the worktree stays clean of', async t => {
	const {main, tree, git} = worktree(t);
	await installAgentRules('agy', tree);
	await installAgentRules('/usr/local/bin/agy --flag', tree);

	const rule = fs.readFileSync(
		path.join(tree, '.agents', 'rules', 'pappardelle.md'),
		'utf8',
	);
	t.true(rule.startsWith('---\ntrigger: always_on\n---\n'));
	t.regex(rule, /first call companion_run/);
	t.is(git(tree, 'status', '--porcelain').stdout, '');

	const exclude = fs.readFileSync(
		path.join(main, '.git', 'info', 'exclude'),
		'utf8',
	);
	t.is(exclude.split('.agents/rules/pappardelle.md').length - 1, 1);
	t.is(git(main, 'worktree', 'remove', tree).status, 0);
});

test('other agents get no rule file', async t => {
	const {tree} = worktree(t);
	await installAgentRules('codex', tree);
	t.false(fs.existsSync(path.join(tree, '.agents')));
});
