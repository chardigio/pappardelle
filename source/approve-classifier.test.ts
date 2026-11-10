import test from 'ava';
import {
	classifierInput,
	classifyCommand,
	type ClassifierRun,
} from './approve-classifier.ts';

const request = {
	command: 'bun run build',
	cwd: '/home/u/.worktrees/repo/STA-1',
	scratchRoots: ['/tmp/q-'],
};

const answering =
	(stdout: string, status = 0): ClassifierRun =>
	async () => ({status, stdout});

const verdict = (structured: unknown) =>
	JSON.stringify({result: '', structured_output: structured});

test('a yes from the model approves, with its reason', async t => {
	t.deepEqual(
		await classifyCommand(
			request,
			answering(verdict({approve: true, reason: 'a local build'})),
		),
		{allow: true, reason: 'a local build'},
	);
});

test('anything short of a clear yes leaves it for a person', async t => {
	const runs: ClassifierRun[] = [
		answering(verdict({approve: false, reason: 'pushes'})),
		answering(verdict({approve: 'yes', reason: 'x'})),
		answering(verdict(undefined)),
		answering('not json'),
		answering(verdict({approve: true, reason: 'x'}), 1),
		async () => {
			throw new Error('spawn claude ENOENT');
		},
	];
	const verdicts = await Promise.all(
		runs.map(async run => classifyCommand(request, run)),
	);
	t.true(verdicts.every(verdict => !verdict.allow));
});

test('the model is told where the agent works and which dirs are scratch', t => {
	t.is(
		classifierInput(request),
		[
			'Working directory: /home/u/.worktrees/repo/STA-1',
			'Temp scratch directories: /tmp/q-',
			'Command:',
			'bun run build',
		].join('\n'),
	);
});
