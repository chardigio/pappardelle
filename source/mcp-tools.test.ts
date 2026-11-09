// Tool inputs against the real CLI parsers, so a flag renamed on one side
// fails here instead of at an agent's first call.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import {parseCli, parseSendArgs, subcommandGate} from './cli-args.ts';
import {parseCompanionArgs} from './companion-args.ts';
import {AUTO_APPROVED_TOOLS, MCP_TOOLS, type CliCall} from './mcp-tools.ts';

function call(name: string, input: Record<string, unknown>): CliCall {
	const tool = MCP_TOOLS.find(candidate => candidate.name === name);
	if (!tool) throw new Error(`No tool ${name}`);
	return tool.toCli(input);
}

const companion = (name: string, input: Record<string, unknown>) => {
	const {args} = call(name, input);
	return {verb: args[0], command: parseCompanionArgs(args.slice(1))};
};

test('companion_run passes a shell line through as one command', t => {
	t.like(
		companion('companion_run', {
			command: 'npm run dev | less -R',
			pane: 'app',
			split: 'right',
			size: '30%',
			space: 'STA-1',
		}),
		{
			verb: 'companion',
			command: {
				verb: 'run',
				command: 'npm run dev | less -R',
				pane: 'app',
				split: 'right',
				size: '30%',
				space: 'STA-1',
			},
		},
	);
});

test('companion_run keeps a command that starts with a dash as the command', t => {
	t.like(companion('companion_run', {command: '--help'}).command, {
		verb: 'run',
		command: '--help',
		pane: 'main',
	});
});

test('companion_type sends its text on stdin, leaving no text in argv', t => {
	const {args, stdin} = call('companion_type', {
		text: '-rf "quoted"',
		enter: false,
		pane: 'side',
	});
	t.is(stdin, '-rf "quoted"');
	t.deepEqual(parseCompanionArgs(args.slice(1)), {
		verb: 'keys',
		space: undefined,
		pane: 'side',
		enter: false,
		keys: [],
		text: undefined,
	});
});

test('companion_press_keys presses names in order', t => {
	t.like(
		companion('companion_press_keys', {keys: ['q', 'Escape'], space: 'STA-1'})
			.command,
		{verb: 'keys', keys: ['q', 'Escape'], space: 'STA-1', pane: 'main'},
	);
});

test('companion_read, resize, close, list and width reach their verbs', t => {
	t.like(companion('companion_read', {lines: 5, pane: 'a'}).command, {
		verb: 'read',
		lines: 5,
		pane: 'a',
	});
	t.like(
		companion('companion_resize', {pane: 'a', width: '40%', height: '10'})
			.command,
		{verb: 'resize', pane: 'a', width: '40%', height: '10'},
	);
	t.like(companion('companion_close', {pane: 'a', space: 'S'}).command, {
		verb: 'close',
		pane: 'a',
		space: 'S',
	});
	t.like(companion('companion_list', {}).command, {verb: 'list', json: true});
	t.like(companion('companion_width', {width: 'reset'}).command, {
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

test('spaces_list and space_read ask for JSON', t => {
	t.like(cli('spaces_list', {}), {
		positional: ['spaces'],
		flags: {json: true},
	});
	t.like(cli('space_read', {key: 'STA-1', turns: 3}), {
		positional: ['read', 'STA-1'],
		flags: {json: true, turns: 3},
	});
});

test('space_send sends its text on stdin', t => {
	const {args, stdin} = call('space_send', {key: 'STA-1', text: "don't -x"});
	t.deepEqual(parseSendArgs(args), {key: 'STA-1', text: '', keys: []});
	t.is(stdin, "don't -x");
});

test('space_press_keys sends repeated --keys', t => {
	const {args} = call('space_press_keys', {
		key: 'STA-1',
		keys: ['Escape', 'S-Tab'],
	});
	t.deepEqual(parseSendArgs(args), {
		key: 'STA-1',
		text: '',
		keys: ['Escape', 'S-Tab'],
	});
});

test('space_open keeps a description that starts with a dash as the input', t => {
	const {positional, flags} = cli('space_open', {
		input: '-fix the login',
		profile: 'mobile',
	});
	t.deepEqual(positional, ['-fix the login']);
	t.is(flags.profile, 'mobile');
	t.is(flags.resume, undefined);
	t.is(flags.wait, undefined);
});

test('space_open maps resume both ways and wait', t => {
	t.like(cli('space_open', {input: 'STA-1', resume: true, wait: true}), {
		positional: ['STA-1'],
		flags: {resume: true, wait: true},
	});
	t.like(cli('space_open', {input: 'STA-1', resume: false}), {
		flags: {resume: false},
	});
});

test('space_close confirms for the agent, which has no terminal', t => {
	t.like(cli('space_close', {key: 'STA-1'}), {
		positional: ['close', 'STA-1'],
		flags: {yes: true},
	});
});

test('tui_restart is the soft restart', t => {
	const {positional, flags} = cli('tui_restart', {});
	t.deepEqual(positional, ['restart']);
	t.falsy(flags.hard);
});

test('no tool can end every session or update Pappardelle', t => {
	const names = MCP_TOOLS.map(tool => tool.name);
	t.false(names.some(name => /update|hard/.test(name)));
});

test('link_pr runs from the source repository and passes the workspace on', t => {
	const {args, cwd} = call('link_pr', {
		url: 'https://github.com/o/r/pull/7',
		repository: '/work/child',
		workspace: '/work',
	});
	t.is(cwd, '/work/child');
	const {input, flags} = parseCli(args);
	t.deepEqual(input, ['link-pr', 'https://github.com/o/r/pull/7']);
	t.is(flags.workspace, '/work');
	t.is(call('link_pr', {url: 'https://x'}).cwd, undefined);
});

test('exactly the companion tools are auto-approved', t => {
	t.deepEqual(
		[...AUTO_APPROVED_TOOLS].sort(),
		MCP_TOOLS.map(tool => tool.name)
			.filter(name => name.startsWith('companion_'))
			.sort(),
	);
});

const pluginHooks = path.join(
	import.meta.dirname,
	'..',
	'plugins',
	'pappardelle',
	'hooks',
);

test("Claude Code's approval hook matches the companion tools and no others", t => {
	const {hooks} = JSON.parse(
		fs.readFileSync(path.join(pluginHooks, 'hooks.json'), 'utf8'),
	) as {
		hooks: {
			PreToolUse: Array<{matcher: string; hooks: Array<{command: string}>}>;
		};
	};
	const entry = hooks.PreToolUse.find(({hooks}) =>
		hooks.some(({command}) => command.includes('approve-companion-tool')),
	);
	const matcher = new RegExp(`^(${entry!.matcher})$`);
	const names = MCP_TOOLS.map(tool => tool.name);
	t.deepEqual(
		names.filter(name =>
			matcher.test(`mcp__plugin_pappardelle_pappardelle__${name}`),
		),
		names.filter(name => name.startsWith('companion_')),
	);
});

test('the approval hook answers allow', t => {
	const {stdout, status} = spawnSync(
		path.join(pluginHooks, 'approve-companion-tool.sh'),
		{encoding: 'utf8'},
	);
	t.is(status, 0);
	t.like(JSON.parse(stdout), {
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'allow',
		},
	});
});
