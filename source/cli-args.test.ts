import {test, expect} from 'bun:test';
import {parseCli, parseSendArgs, subcommandGate} from './cli-args.ts';

test('--restart-tuis is unset unless passed, so update can ask on a TTY', () => {
	expect(parseCli(['update']).flags.restartTuis).toBe(undefined);
	expect(parseCli(['update', '--restart-tuis']).flags.restartTuis).toBe(true);
	expect(parseCli(['update', '--no-restart-tuis']).flags.restartTuis).toBe(
		false,
	);
});

test('--layout still defaults on', () => {
	expect(parseCli([]).flags.layout).toBe(true);
	expect(parseCli(['--no-layout']).flags.layout).toBe(false);
});

test("--help on close, restart or update prints that command's help and runs nothing", () => {
	for (const argv of [
		['close', '--help'],
		['close', 'STA-1', '--yes', '-h'],
		['restart', '--help'],
		['restart', '--hard', '--yes', '-h'],
		['update', '--help'],
	]) {
		const gate = subcommandGate(argv);
		expect(gate.action).toBe('help');
		if (gate.action === 'help') {
			expect(gate.text.includes(`$ pappardelle ${argv[0]}`)).toBe(true);
		}
	}
});

test('plugin install answers --help and rejects flags instead of installing', () => {
	const help = subcommandGate(['plugin', 'install', '--help']);
	expect(help.action).toBe('help');
	if (help.action === 'help') {
		expect(help.text.includes('$ pappardelle plugin install')).toBe(true);
	}

	expect(subcommandGate(['plugin', 'install', '--yes'])).toStrictEqual({
		action: 'reject',
		message:
			'Unknown flag --yes for pappardelle plugin install\nUsage: pappardelle plugin install\nRun pappardelle plugin install --help for details',
	});
});

test('close, restart and update reject flags that are not theirs', () => {
	const usages: Record<string, string> = {
		close: 'Usage: pappardelle close <issue-key> [--yes]',
		restart: 'Usage: pappardelle restart [--hard [--yes]]',
		update: 'Usage: pappardelle update [--restart-tuis | --no-restart-tuis]',
	};
	for (const [argv, flag] of [
		[['close', 'STA-1', '--bogus'], '--bogus'],
		[['close', 'STA-1', '--hard'], '--hard'],
		[['restart', '--bogus'], '--bogus'],
		[['restart', '--restart-tuis'], '--restart-tuis'],
		[['update', '--hard'], '--hard'],
		[['update', '--restart-tuis', '--no-layout'], '--no-layout'],
	] as const) {
		const gate = subcommandGate(argv);
		expect(gate.action).toBe('reject');
		if (gate.action === 'reject') {
			expect(gate.message.split('\n')).toStrictEqual([
				`Unknown flag ${flag} for pappardelle ${argv[0]}`,
				usages[argv[0]],
				`Run pappardelle ${argv[0]} --help for details`,
			]);
		}
	}
});

test('update rejects asking to both restart and leave TUIs', () => {
	const gate = subcommandGate([
		'update',
		'--restart-tuis',
		'--no-restart-tuis',
	]);
	expect(gate.action).toBe('reject');
});

test('plugin commands other than install are rejected, not run as a prompt', () => {
	for (const argv of [
		['plugin'],
		['plugin', 'instal'],
		['plugin', 'uninstall'],
		['plugin', 'install', 'extra'],
	]) {
		expect(subcommandGate(argv)).toStrictEqual({
			action: 'reject',
			message: `Unknown command pappardelle ${argv.join(' ')}\nUsage: pappardelle plugin install`,
		});
	}

	expect(subcommandGate(['plugin', '--help']).action).toBe('help');
});

test('known flags and every other command pass through', () => {
	for (const argv of [
		['close', 'STA-1'],
		['close', 'STA-1', '--yes'],
		['close', 'STA-1', '--yes', '--teardown-only'],
		['restart'],
		['restart', '--hard', '--yes'],
		['update', '--restart-tuis'],
		['update', '--no-restart-tuis'],
		[],
		['--no-layout'],
		['fix the --verbose flag'],
		['send', 'STA-1', '--help'],
		['plugin', 'install'],
	]) {
		expect(subcommandGate(argv)).toStrictEqual({action: 'run'});
	}
});

test('send takes everything after the key as the text, flags included', () => {
	expect(parseSendArgs(['send', 'STE-1', 'hi', '-x', 'there'])).toStrictEqual({
		key: 'STE-1',
		text: 'hi -x there',
		keys: [],
		force: false,
	});
	expect(parseSendArgs(['send', 'STE-1', '--help'])).toStrictEqual({
		key: 'STE-1',
		text: '--help',
		keys: [],
		force: false,
	});
	expect(parseSendArgs(['send', 'STE-1', '-x'])).toStrictEqual({
		key: 'STE-1',
		text: '-x',
		keys: [],
		force: false,
	});
	expect(
		parseSendArgs(['--no-layout', 'send', 'STE-1', '--yes']),
	).toStrictEqual({
		key: 'STE-1',
		text: '--yes',
		keys: [],
		force: false,
	});
});

test('send takes --keys and --force only right after the key', () => {
	expect(
		parseSendArgs(['send', 'STE-1', '--keys', 'Escape', '--keys=S-Tab']),
	).toStrictEqual({
		key: 'STE-1',
		text: '',
		keys: ['Escape', 'S-Tab'],
		force: false,
	});
	expect(
		parseSendArgs(['send', 'STE-1', 'use', '--keys', 'Escape']),
	).toStrictEqual({
		key: 'STE-1',
		text: 'use --keys Escape',
		keys: [],
		force: false,
	});
});

test('send without text leaves it empty so stdin is read', () => {
	expect(parseSendArgs(['send', 'STE-1'])).toStrictEqual({
		key: 'STE-1',
		text: '',
		keys: [],
		force: false,
	});
});

test('send with a flag where the key goes has no key, so usage is printed', () => {
	expect(parseSendArgs(['send', '--help']).key).toBe(undefined);
	expect(parseSendArgs(['send']).key).toBe(undefined);
});

test('--resume accepts either position without consuming the input', () => {
	for (const argv of [
		['--resume', 'STE-20'],
		['STE-20', '--resume'],
	]) {
		const cli = parseCli(argv);
		expect(cli.flags.resume).toBe(true);
		expect(cli.input).toStrictEqual(['STE-20']);
	}

	expect(parseCli(['STE-20']).flags.resume).toBe(undefined);
	expect(parseCli(['STE-20', '--no-resume']).flags.resume).toBe(false);
	expect(parseCli(['--resume', 'fix auth bug']).input).toStrictEqual([
		'fix auth bug',
	]);
});

test('--profile preserves its name and positional input in either order', () => {
	for (const argv of [
		['--profile', 'mobile', 'STE-20'],
		['STE-20', '--profile', 'mobile'],
	]) {
		const cli = parseCli(argv);
		expect(cli.flags.profile).toBe('mobile');
		expect(cli.input).toStrictEqual(['STE-20']);
	}
	expect(parseCli(['--profile', '123', 'STE-20']).flags.profile).toBe('123');
	expect(parseCli(['STE-20']).flags.profile).toBe(undefined);
});

test('close --help documents --yes but not the internal --teardown-only', () => {
	const gate = subcommandGate(['close', '--help']);
	expect(gate.action).toBe('help');
	if (gate.action === 'help') {
		expect(gate.text.includes('--yes')).toBe(true);
		expect(gate.text.includes('--teardown-only')).toBe(false);
	}

	expect(parseCli([]).help.includes('--teardown-only')).toBe(false);
	expect(
		parseCli(['close', 'STA-1', '--teardown-only']).flags.teardownOnly,
	).toBe(true);
});

test("send's text never reaches the top-level flag checks", () => {
	const cli = parseCli(['send', 'STA-1', 'run with', '--profile']);
	expect(cli.flags.profile).toBe(undefined);
	expect(cli.input).toStrictEqual(['send']);
});

test('mcp answers --help and rejects flags it does not know', () => {
	expect(subcommandGate(['mcp']).action).toBe('run');
	expect(subcommandGate(['mcp', '--help']).action).toBe('help');
	expect(subcommandGate(['mcp', '--nope']).action).toBe('reject');
	expect(subcommandGate(['mcp', 'install']).action).toBe('run');
	expect(subcommandGate(['mcp', 'nope']).action).toBe('reject');
});

test('a --force after the text is the flag, not part of the message', () => {
	expect(
		parseSendArgs(['send', 'STE-1', 'hello', 'there', '--force']),
	).toStrictEqual({
		key: 'STE-1',
		text: 'hello there',
		keys: [],
		force: true,
	});
});

test('a --force inside the message stays text', () => {
	expect(
		parseSendArgs(['send', 'STE-1', 'why', '--force', 'is', 'risky']),
	).toMatchObject({
		text: 'why --force is risky',
		force: false,
	});
});
