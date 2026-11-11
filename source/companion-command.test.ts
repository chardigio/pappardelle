import test from 'ava';
import {runCompanionCommand} from './companion-command.ts';

const OFF = "STA-1's companion is off";

function harness(off: string | null) {
	const out: string[] = [];
	const err: string[] = [];
	const asked: string[] = [];
	return {
		out,
		err,
		asked,
		run: async (...argv: string[]) =>
			runCompanionCommand(argv, {
				resolveSpace: flag => flag ?? 'STA-1',
				repoName: () => 'repo',
				readStdin: () => 'typed',
				out: text => out.push(text),
				err: text => err.push(text),
				companionOff(space) {
					asked.push(space);
					return off;
				},
			}),
	};
}

for (const argv of [
	['run', '--', 'bun', 'dev'],
	['run', '--pane', 'tests', '--', 'bun', 'test'],
	['keys', 'hello'],
	['read'],
	['resize', 'tests', '--size', '40'],
	['close', 'tests'],
	['list'],
	['width', '60'],
]) {
	test(`companion ${argv[0]!} refuses with a clear error when the companion is off (${argv.join(' ')})`, async t => {
		const h = harness(OFF);
		t.is(await h.run(...argv), 1);
		t.deepEqual(h.err, [OFF]);
		t.deepEqual(h.out, []);
		t.deepEqual(h.asked, ['STA-1']);
	});
}

test('the companion check uses the space that --space names', async t => {
	const h = harness(OFF);
	t.is(await h.run('list', '--space', 'STA-7'), 1);
	t.deepEqual(h.asked, ['STA-7']);
});

test('help works when the companion is off, and usage errors keep exit 2', async t => {
	const h = harness(OFF);
	t.is(await h.run('--help'), 0);
	t.true(h.out[0]!.includes('companion'));
	t.is(await h.run('resize'), 2);
	t.deepEqual(h.asked, []);
});
