import {test, expect} from 'bun:test';
import {testConfig} from '../test/helpers/config-fixtures.ts';
import {
	runAgentProfileCommand,
	type AgentProfileCommandDeps,
} from './agent-profile-command.ts';
import type {PappardelleConfig} from './config.ts';

function deps(loadConfig: () => PappardelleConfig) {
	const out: string[] = [];
	const err: string[] = [];
	const commandDeps: AgentProfileCommandDeps = {
		loadConfig,
		loadSources: () => ({
			'codex-sol:high': [
				'.pappardelle.local.yml',
				'~/.pappardelle/.pappardelle.yml',
			],
		}),
		out: text => out.push(text),
		err: text => err.push(text),
	};
	return {commandDeps, out, err};
}

const config = testConfig({
	agent_profiles: {
		'codex-sol:high': {command: 'codex'},
		aider: {command: 'aider'},
	},
});

test('list prints one agent profile name per line, the built-in claude first', () => {
	const d = deps(() => config);
	expect(runAgentProfileCommand(['list'], d.commandDeps)).toBe(0);
	expect(d.out).toStrictEqual(['claude\ncodex-sol:high\naider']);
	expect(d.err).toStrictEqual([]);
});

test('list --json gives each name with the files defining it as a list', () => {
	const d = deps(() => config);
	expect(runAgentProfileCommand(['list', '--json'], d.commandDeps)).toBe(0);
	expect(JSON.parse(d.out[0]!)).toStrictEqual([
		{name: 'claude', sources: []},
		{
			name: 'codex-sol:high',
			sources: ['.pappardelle.local.yml', '~/.pappardelle/.pappardelle.yml'],
		},
		{name: 'aider', sources: []},
	]);
});

test('an unknown verb or flag is a usage error, not a listing', () => {
	for (const argv of [[], ['ls'], ['list', '--yaml']]) {
		const d = deps(() => config);
		expect(
			runAgentProfileCommand(argv, d.commandDeps),
			`argv: ${argv.join(' ')}`,
		).toBe(2);
		expect(d.out).toStrictEqual([]);
		expect(d.err.join('\n')).toMatch(/Usage: pappardelle agent-profile list/);
	}
});

test('-h and --help print the help, before or after the verb', () => {
	for (const argv of [['-h'], ['--help'], ['list', '-h'], ['list', '--help']]) {
		const d = deps(() => config);
		expect(
			runAgentProfileCommand(argv, d.commandDeps),
			`argv: ${argv.join(' ')}`,
		).toBe(0);
		expect(d.out.join('\n')).toMatch(/agent-profile list/);
		expect(d.err).toStrictEqual([]);
	}
});

test('an unreadable config exits 3 with the reason', () => {
	const d = deps(() => {
		throw new Error('Not in a git repository');
	});
	expect(runAgentProfileCommand(['list'], d.commandDeps)).toBe(3);
	expect(d.err).toStrictEqual([
		'Could not read the config: Not in a git repository',
	]);
});
