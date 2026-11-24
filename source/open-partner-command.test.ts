import test from 'ava';
import {
	runOpenPartnerCommand,
	type OpenPartnerDeps,
} from './open-partner-command.ts';
import type {PartnerAgent} from './partner-agents.ts';

function deps(
	overrides: Partial<OpenPartnerDeps> = {},
): OpenPartnerDeps & {lines: string[]; errors: string[]; starts: boolean[]} {
	const lines: string[] = [];
	const errors: string[] = [];
	const starts: boolean[] = [];
	return {
		running: () => false,
		async start(fresh) {
			starts.push(fresh);
			return true;
		},
		waitForAgent: async () => true,
		now: () => 1000,
		print: line => lines.push(line),
		printError: line => errors.push(line),
		...overrides,
		lines,
		errors,
		starts,
	};
}

const trotbot: PartnerAgent = {
	name: 'trotbot',
	attach: {socket: 'trotbot', session: 'bot'},
};
const reviewer: PartnerAgent = {name: 'reviewer', agent_profile: 'codex'};

test('an attach partner is never started: running is fine, down says where it runs', async t => {
	const up = deps({running: () => true});
	t.is(await runOpenPartnerCommand(trotbot, {wait: true}, up), 0);
	t.deepEqual(up.starts, []);

	const down = deps();
	t.is(await runOpenPartnerCommand(trotbot, {wait: true}, down), 1);
	t.deepEqual(down.starts, []);
	t.regex(down.errors[0]!, /tmux -L trotbot, session bot/);
	t.regex(down.errors[0]!, /never starts it/);
});

test('a running launched partner is left as it is', async t => {
	const d = deps({running: () => true});
	t.is(await runOpenPartnerCommand(reviewer, {wait: true}, d), 0);
	t.deepEqual(d.starts, []);
	t.deepEqual(d.lines, ['Partner agent reviewer is running']);
});

test('a launched partner that is down starts on its own conversation, fresh only on --no-resume', async t => {
	const resumed = deps();
	t.is(await runOpenPartnerCommand(reviewer, {wait: false}, resumed), 0);
	t.deepEqual(resumed.starts, [false]);

	const fresh = deps();
	t.is(
		await runOpenPartnerCommand(reviewer, {resume: false, wait: false}, fresh),
		0,
	);
	t.deepEqual(fresh.starts, [true]);
});

test('--wait fails with 3 when the started partner is not confirmed, and start failures fail', async t => {
	const since: number[] = [];
	const unconfirmed = deps({
		async waitForAgent(from) {
			since.push(from);
			return false;
		},
	});
	t.is(await runOpenPartnerCommand(reviewer, {wait: true}, unconfirmed), 3);
	t.deepEqual(since, [1000]);
	t.regex(unconfirmed.errors[0]!, /not confirmed/);

	const failed = deps({start: async () => false});
	t.is(await runOpenPartnerCommand(reviewer, {wait: true}, failed), 1);
	t.deepEqual(failed.errors, ['Could not start partner agent reviewer']);
});
