import test from 'ava';
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

const config = {
	agent_profiles: {
		'codex-sol:high': {command: 'codex'},
		aider: {command: 'aider'},
	},
} as unknown as PappardelleConfig;

test('list prints one agent profile name per line, the built-in claude first', t => {
	const d = deps(() => config);
	t.is(runAgentProfileCommand(['list'], d.commandDeps), 0);
	t.deepEqual(d.out, ['claude\ncodex-sol:high\naider']);
	t.deepEqual(d.err, []);
});

test('list --json gives each name with the files defining it as a list', t => {
	const d = deps(() => config);
	t.is(runAgentProfileCommand(['list', '--json'], d.commandDeps), 0);
	t.deepEqual(JSON.parse(d.out[0]!), [
		{name: 'claude', sources: []},
		{
			name: 'codex-sol:high',
			sources: ['.pappardelle.local.yml', '~/.pappardelle/.pappardelle.yml'],
		},
		{name: 'aider', sources: []},
	]);
});

test('an unknown verb or flag is a usage error, not a listing', t => {
	for (const argv of [[], ['ls'], ['list', '--yaml']]) {
		const d = deps(() => config);
		t.is(
			runAgentProfileCommand(argv, d.commandDeps),
			2,
			`argv: ${argv.join(' ')}`,
		);
		t.deepEqual(d.out, []);
		t.regex(d.err.join('\n'), /Usage: pappardelle agent-profile list/);
	}
});

test('an unreadable config exits 3 with the reason', t => {
	const d = deps(() => {
		throw new Error('Not in a git repository');
	});
	t.is(runAgentProfileCommand(['list'], d.commandDeps), 3);
	t.deepEqual(d.err, ['Could not read the config: Not in a git repository']);
});
