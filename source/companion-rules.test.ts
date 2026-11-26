import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
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
		getNamedAgentProfile(
			{version: 1, profiles: {}, agent_profiles: {a: definition}},
			'a',
		).rulesArgs,
	);
}

test('the rules survive any shell and a TOML string as they are', () => {
	// Launch lines run in the user's own shell, Nushell and fish included, whose
	// quoting differs for everything except a plain single-quoted string.
	expect(companionRules()).not.toMatch(/['"`$\\]/);
});

test('Codex gets the rules as one -c developer_instructions value', () => {
	const [flag, value, ...rest] = argv(rulesFlagsFor('codex'));
	expect(flag).toBe('-c');
	expect(rest).toStrictEqual([]);
	expect(value!).toMatch(
		/^developer_instructions="[^"\n]*first call companion_run[^"\n]*"$/,
	);
});

test('Pi gets the rules as one --append-system-prompt value', () => {
	const [flag, value, ...rest] = argv(rulesFlagsFor('/opt/bin/pi'));
	expect(flag).toBe('--append-system-prompt');
	expect(rest).toStrictEqual([]);
	expect(value!).not.toMatch(/\n/);
	expect(value!).toMatch(/first call companion_run/);
});

test('agents that get the rules another way get no flags', () => {
	for (const command of ['claude', 'opencode', 'agy', 'aider']) {
		expect(rulesFlagsFor(command)).toBe('');
	}
});

test('an agent gated as claude takes no rules flag, whatever its command', () => {
	expect(rulesFlagsFor('codex', true)).toBe('');
});

const codexProfile = getNamedAgentProfile(
	{
		version: 1,
		profiles: {},
		agent_profiles: {codex: {command: 'codex', resume_args: 'resume --last'}},
	},
	'codex',
);

test("Codex's rules come before the resume subcommand, on both launch paths", () => {
	const command = buildAgentResumeCommand(
		'STA-1',
		false,
		codexProfile,
		undefined,
		{rules: true},
	);
	const rules = rulesFlagsFor('codex');
	expect(rules).not.toBe('');
	expect(command).toBe(
		`codex${rules} resume --last || { printf '\\033[A\\033[2K'; false; } || codex${rules}`,
	);
});

test('an agent launched without workspace awareness gets no rules', () => {
	expect(buildAgentResumeCommand('STA-1', false, codexProfile)).toBe(
		"codex resume --last || { printf '\\033[A\\033[2K'; false; } || codex",
	);
});

function worktree() {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rules-')),
	);
	teardown(() => {
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

test('agy gets an always-on rule the worktree stays clean of', async () => {
	const {main, tree, git} = worktree();
	await installAgentRules('agy', tree);
	await installAgentRules('/usr/local/bin/agy --flag', tree);

	const rule = fs.readFileSync(
		path.join(tree, '.agents', 'rules', 'pappardelle.md'),
		'utf8',
	);
	expect(rule.startsWith('---\ntrigger: always_on\n---\n')).toBe(true);
	expect(rule).toMatch(/first call companion_run/);
	expect(git(tree, 'status', '--porcelain').stdout).toBe('');

	const exclude = fs.readFileSync(
		path.join(main, '.git', 'info', 'exclude'),
		'utf8',
	);
	expect(exclude.split('.agents/rules/pappardelle.md').length - 1).toBe(1);
	expect(git(main, 'worktree', 'remove', tree).status).toBe(0);
});

test('other agents get no rule file', async () => {
	const {tree} = worktree();
	await installAgentRules('codex', tree);
	await installAgentRules('env FOO=agy codex', tree);
	await installAgentRules('codex --note agy', tree);
	expect(fs.existsSync(path.join(tree, '.agents'))).toBe(false);
});

test('wrapper commands still detect agy and write space identity and role-appropriate messaging rules', async () => {
	const {tree: workerTree} = worktree();
	await installAgentRules('env FOO=1 agy --flag', workerTree, {
		space: 'STA-42',
		repo: 'pappardelle',
		role: 'worker',
	});
	const workerRule = fs.readFileSync(
		path.join(workerTree, '.agents', 'rules', 'pappardelle.md'),
		'utf8',
	);
	expect(workerRule).toMatch(/space STA-42 \(repo pappardelle\)/);
	expect(workerRule).toMatch(/space_send/);
	expect(workerRule).toMatch(/spaces_list/);
	expect(workerRule).toMatch(
		/sous-chef in the main checkout \(space key `main`\)/,
	);
	expect(workerRule).not.toMatch(/use SendMessage|reach it with SendMessage/i);

	const {tree: mainTree} = worktree();
	await installAgentRules('/usr/local/bin/agy', mainTree, {
		space: 'main',
		repo: 'pappardelle',
		role: 'sous-chef',
	});
	const mainRule = fs.readFileSync(
		path.join(mainTree, '.agents', 'rules', 'pappardelle.md'),
		'utf8',
	);
	expect(mainRule).toMatch(
		/space main \(repo pappardelle\), running in sous-chef mode/,
	);
	expect(mainRule).toMatch(/space_watch/);
	expect(mainRule).toMatch(/space_answer/);
	expect(mainRule).toMatch(/space_send/);
	expect(mainRule).not.toMatch(/use SendMessage|reach it with SendMessage/i);

	const script = path.join(
		import.meta.dirname,
		'..',
		'scripts',
		'install-agent-rules.sh',
	);
	const missingValue = spawnSync(script, ['agy', workerTree, '--space'], {
		encoding: 'utf8',
	});
	expect(missingValue.status).toBe(2);
	const unknownFlag = spawnSync(script, ['agy', workerTree, '--bogus', '1'], {
		encoding: 'utf8',
	});
	expect(unknownFlag.status).toBe(2);
});
