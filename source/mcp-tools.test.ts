// Tool inputs against the real CLI parsers, so a flag renamed on one side
// fails here instead of at an agent's first call.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {testState} from '../test/helpers/state.ts';
import {runAgentProfileCommand} from './agent-profile-command.ts';
import {parseCli, parseSendArgs, subcommandGate} from './cli-args.ts';
import {parseCompanionArgs} from './companion-args.ts';
import type {PappardelleConfig} from './config.ts';
import {AUTO_APPROVED_TOOLS, MCP_TOOLS, type CliCall} from './mcp-tools.ts';
import {runSpaceCommand} from './space-command.ts';
import {newSpaceIdentity} from './space-identity.ts';
import {encodeCursor} from './space-watch.ts';
import {parseSuperviseArgs} from './supervise-args.ts';

function call(
	name: string,
	input: Record<string, unknown>,
	context?: {sender?: string},
): CliCall {
	const tool = MCP_TOOLS.find(candidate => candidate.name === name);
	if (!tool) throw new Error(`No tool ${name}`);
	return tool.toCli(input, context);
}

const companion = (name: string, input: Record<string, unknown>) => {
	const {args} = call(name, input);
	return {verb: args[0], command: parseCompanionArgs(args.slice(1))};
};

test('companion_run passes a shell line through as one command', () => {
	expect(
		companion('companion_run', {
			command: 'npm run dev | less -R',
			pane: 'app',
			split: 'right',
			size: '30%',
			space: 'STA-1',
		}),
	).toMatchObject({
		verb: 'companion',
		command: {
			verb: 'run',
			command: 'npm run dev | less -R',
			pane: 'app',
			split: 'right',
			size: '30%',
			space: 'STA-1',
		},
	});
});

test('companion_run keeps a command that starts with a dash as the command', () => {
	expect(companion('companion_run', {command: '--help'}).command).toMatchObject(
		{
			verb: 'run',
			command: '--help',
			pane: 'main',
		},
	);
});

test('companion_type sends its text on stdin, leaving no text in argv', () => {
	const {args, stdin} = call('companion_type', {
		text: '-rf "quoted"',
		enter: false,
		pane: 'side',
	});
	expect(stdin).toBe('-rf "quoted"');
	expect(parseCompanionArgs(args.slice(1))).toStrictEqual({
		verb: 'keys',
		space: undefined,
		pane: 'side',
		enter: false,
		keys: [],
		text: undefined,
	});
});

test('companion_press_keys presses names in order', () => {
	expect(
		companion('companion_press_keys', {keys: ['q', 'Escape'], space: 'STA-1'})
			.command,
	).toMatchObject({
		verb: 'keys',
		keys: ['q', 'Escape'],
		space: 'STA-1',
		pane: 'main',
	});
});

test('companion_read, resize, close, list and width reach their verbs', () => {
	expect(
		companion('companion_read', {lines: 5, pane: 'a'}).command,
	).toMatchObject({
		verb: 'read',
		lines: 5,
		pane: 'a',
	});
	expect(
		companion('companion_resize', {pane: 'a', size: '40%'}).command,
	).toMatchObject({
		verb: 'resize',
		pane: 'a',
		size: '40%',
	});
	expect(
		companion('companion_resize', {pane: 'a', size: '12'}).command,
	).toMatchObject({
		size: 12,
	});
	expect(
		companion('companion_close', {pane: 'a', space: 'S'}).command,
	).toMatchObject({
		verb: 'close',
		pane: 'a',
		space: 'S',
	});
	expect(companion('companion_list', {}).command).toMatchObject({
		verb: 'list',
		json: true,
	});
	expect(companion('companion_width', {width: 'reset'}).command).toMatchObject({
		verb: 'width',
		width: 'reset',
	});
});

const cli = (name: string, input: Record<string, unknown>) => {
	const {args, stdin} = call(name, input);
	const gate = subcommandGate(args);
	if (gate.action !== 'run') throw new Error(`gate: ${JSON.stringify(gate)}`);
	const {input: positional, flags} = parseCli(args);
	return {positional, flags, stdin};
};

test('spaces_list and space_read ask for JSON', () => {
	expect(cli('spaces_list', {})).toMatchObject({
		positional: ['spaces'],
		flags: {json: true},
	});
	expect(cli('space_read', {key: 'STA-1', turns: 3})).toMatchObject({
		positional: ['read', 'STA-1'],
		flags: {json: true, turns: 3},
	});
});

test('space_get maps onto space get, and all onto space list', async () => {
	const outputs: string[] = [];
	const errors: string[] = [];
	const state = testState();
	await state.daos.spaceIdentities.record(
		newSpaceIdentity({
			repo: state.repo,
			key: 'STA-1',
			worktreePath: '/home/u/.worktrees/repo/STA-1',
			socket: 'pappardelle_inner',
		}),
	);
	await state.daos.registry.add('STA-1');
	await state.daos.spaceState.write('STA-1', {profile: 'dev'});
	const run = async (input: Record<string, unknown>) => {
		const [, ...argv] = call('space_get', input).args;
		return runSpaceCommand(argv, {
			checkout: () => ({
				kind: 'checkout',
				checkout: {repoName: state.repo, mainRoot: '/repo'},
			}),
			daos: () => state.daos,
			env: {PAPPARDELLE_SPACE: 'STA-1'},
			cwd: '/',
			runner: () => ({status: 1, stdout: ''}),
			gitBranch: async () => null,
			resolveKey: raw => raw,
			out: text => outputs.push(text),
			err: text => errors.push(text),
		});
	};

	expect(await run({field: 'profile'})).toBe(0);
	expect(await run({space: 'STA-1', field: 'tmux.agentTarget'})).toBe(0);
	expect(await run({})).toBe(0);
	expect(await run({all: true})).toBe(0);
	expect(outputs.slice(0, 2)).toStrictEqual(['dev', '=agent-repo-STA-1:']);
	expect(JSON.parse(outputs[2]!)).toMatchObject({key: 'STA-1', profile: 'dev'});
	expect(
		(JSON.parse(outputs[3]!) as Array<{key: string}>).map(each => each.key),
	).toStrictEqual(['main', 'STA-1']);
	expect(errors).toStrictEqual([]);
});

test('space_open passes agent_profile to the CLI as --agent-profile', () => {
	expect(
		cli('space_open', {
			input: 'STA-1',
			profile: 'dev',
			agent_profile: 'antigravity-neon:high',
		}),
	).toMatchObject({
		positional: ['STA-1'],
		flags: {profile: 'dev', agentProfile: 'antigravity-neon:high'},
	});
	expect(cli('space_open', {input: 'STA-1'}).flags.agentProfile).toBe(
		undefined,
	);
});

test('agent_profiles_list maps onto agent-profile list as JSON', () => {
	const [verb, ...argv] = call('agent_profiles_list', {}).args;
	expect(verb).toBe('agent-profile');
	const out: string[] = [];
	const errors: string[] = [];
	const code = runAgentProfileCommand(argv, {
		loadConfig: () =>
			({
				agent_profiles: {codex: {command: 'codex'}},
			}) as unknown as PappardelleConfig,
		loadSources: () => ({codex: ['.pappardelle.yml']}),
		out: text => out.push(text),
		err: text => errors.push(text),
	});
	expect(code).toBe(0);
	expect(errors).toStrictEqual([]);
	expect(JSON.parse(out[0]!)).toStrictEqual([
		{name: 'claude', sources: []},
		{name: 'codex', sources: ['.pappardelle.yml']},
	]);
});

test('space_get refuses all together with a space or a field', () => {
	expect(() => call('space_get', {all: true, space: 'STA-1'})).toThrow();
	expect(() => call('space_get', {all: true, field: 'profile'})).toThrow();
});

test('space_highlight passes focus on only when asked', () => {
	expect(cli('space_highlight', {key: 'STA-1', focus: true})).toMatchObject({
		positional: ['highlight', 'STA-1'],
		flags: {focus: true},
	});
	expect(cli('space_highlight', {key: 'STA-1'}).flags.focus).toBeFalsy();
});

test('space_send sends its text on stdin and prepends [from sender] except on command prefixes', () => {
	const {args, stdin} = call('space_send', {key: 'STA-1', text: "don't -x"});
	expect(parseSendArgs(args)).toStrictEqual({
		key: 'STA-1',
		text: '',
		keys: [],
		force: false,
	});
	expect(stdin).toBe("don't -x");

	expect(
		call('space_send', {key: 'STA-2', text: 'hello'}, {sender: 'STA-1'}).stdin,
	).toBe('[from STA-1] hello');
	for (const raw of ['/clear', '$skill', '!ls', '#note']) {
		expect(
			call('space_send', {key: 'STA-2', text: raw}, {sender: 'STA-1'}).stdin,
		).toBe(raw);
	}
});

test('space_press_keys sends repeated --keys', () => {
	const {args} = call('space_press_keys', {
		key: 'STA-1',
		keys: ['Escape', 'S-Tab'],
	});
	expect(parseSendArgs(args)).toStrictEqual({
		key: 'STA-1',
		text: '',
		keys: ['Escape', 'S-Tab'],
		force: false,
	});
});

test('space_open keeps a description that starts with a dash as the input', () => {
	const {positional, flags} = cli('space_open', {
		input: '-fix the login',
		profile: 'mobile',
	});
	expect(positional).toStrictEqual(['-fix the login']);
	expect(flags.profile).toBe('mobile');
	expect(flags.resume).toBe(undefined);
	expect(flags.wait).toBe(undefined);
});

test('space_open maps resume both ways and wait', () => {
	expect(
		cli('space_open', {input: 'STA-1', resume: true, wait: true}),
	).toMatchObject({
		positional: ['STA-1'],
		flags: {resume: true, wait: true},
	});
	expect(cli('space_open', {input: 'STA-1', resume: false})).toMatchObject({
		flags: {resume: false},
	});
});

test('space_close confirms for the agent, which has no terminal', () => {
	expect(cli('space_close', {key: 'STA-1'})).toMatchObject({
		positional: ['close', 'STA-1'],
		flags: {yes: true},
	});
});

test('tui_restart is the soft restart', () => {
	const {positional, flags} = cli('tui_restart', {});
	expect(positional).toStrictEqual(['restart']);
	expect(flags.hard).toBeFalsy();
});

test('no tool can end every session or update Pappardelle', () => {
	const names = MCP_TOOLS.map(tool => tool.name);
	expect(names.some(name => /update|hard/.test(name))).toBe(false);
});

test('link_pr runs from the source repository and passes the workspace on', () => {
	const {args, cwd} = call('link_pr', {
		url: 'https://github.com/o/r/pull/7',
		repository: '/work/child',
		workspace: '/work',
	});
	expect(cwd).toBe('/work/child');
	const {input, flags} = parseCli(args);
	expect(input).toStrictEqual(['link-pr', 'https://github.com/o/r/pull/7']);
	expect(flags.workspace).toBe('/work');
	expect(call('link_pr', {url: 'https://x'}).cwd).toBe(undefined);
});

// Everything an agent changes in another space through these goes through
// a check it can't override: space_answer's approval policy, and send's
// refusal to type into a prompt.
const ASKS_FIRST = new Set([
	'spaces_list',
	'space_read',
	'space_highlight',
	'space_press_keys',
	'space_open',
	'space_close',
	'link_pr',
	'tui_restart',
	// Approving a hold is the chef's word, so its prompt is where they give it.
	'space_hold_resolve',
]);

test('every tool but the ones that ask first is auto-approved', () => {
	expect([...AUTO_APPROVED_TOOLS].sort()).toStrictEqual(
		MCP_TOOLS.map(tool => tool.name)
			.filter(name => !ASKS_FIRST.has(name))
			.sort(),
	);
});

test('space_answer has no way past the approval policy', () => {
	const answer = MCP_TOOLS.find(tool => tool.name === 'space_answer')!;
	expect('force' in answer.inputSchema).toBe(false);
	expect(
		call('space_answer', {key: 'STA-1', option: 1}).args.includes('--force'),
	).toBe(false);
});

const pluginHooks = path.join(
	import.meta.dirname,
	'..',
	'plugins',
	'pappardelle',
	'hooks',
);

test("Claude Code's approval hook matches the auto-approved tools and no others", () => {
	const {hooks} = JSON.parse(
		fs.readFileSync(path.join(pluginHooks, 'hooks.json'), 'utf8'),
	) as {
		hooks: {
			PreToolUse: Array<{matcher: string; hooks: Array<{command: string}>}>;
		};
	};
	const entry = hooks.PreToolUse.find(({hooks}) =>
		hooks.some(({command}) => command.includes('approve-pappardelle-tool')),
	);
	const matcher = new RegExp(`^(${entry!.matcher})$`);
	const names = MCP_TOOLS.map(tool => tool.name);
	expect(
		names.filter(name =>
			matcher.test(`mcp__plugin_pappardelle_pappardelle__${name}`),
		),
	).toStrictEqual([...AUTO_APPROVED_TOOLS]);
});

test('the approval hook answers allow', () => {
	const {stdout, status} = spawnSync(
		path.join(pluginHooks, 'approve-pappardelle-tool.sh'),
		{encoding: 'utf8'},
	);
	expect(status).toBe(0);
	expect(JSON.parse(stdout)).toMatchObject({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'allow',
		},
	});
});

test('space_watch passes its spaces, states and cursor to watch', () => {
	const cursor = encodeCursor({'STA-1': 'idle'});
	expect(
		parseSuperviseArgs(
			call('space_watch', {
				keys: ['STA-1', 'STA-2'],
				until: ['blocked', 'idle'],
				since: cursor,
				timeout_seconds: 30,
			}).args,
		),
	).toStrictEqual({
		verb: 'watch',
		keys: ['STA-1', 'STA-2'],
		until: ['blocked', 'idle'],
		since: {'STA-1': 'idle'},
		timeoutSeconds: 30,
		json: true,
	});
	expect(parseSuperviseArgs(call('space_watch', {}).args)).toMatchObject({
		keys: [],
		until: [],
		timeoutSeconds: 50,
	});
});

test('space_answer passes several options and typed text to answer', () => {
	expect(
		parseSuperviseArgs(
			call('space_answer', {key: 'STA-1', options: [1, 3]}).args,
		),
	).toMatchObject({verb: 'answer', options: [1, 3], keys: []});
	expect(
		parseSuperviseArgs(
			call('space_answer', {key: 'STA-1', text: '-- no, the other one'}).args,
		),
	).toMatchObject({verb: 'answer', options: [], text: '-- no, the other one'});
});
