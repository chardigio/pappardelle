import {tokenHash} from './resume-records-sqlite.ts';
import {existsSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {testState} from '../test/helpers/state.ts';
import type {ResumeRecord} from './program-resume.ts';
import {
	finishPaneLaunch,
	preparePaneLaunch,
	readOneShot,
} from './resume-launch.ts';

const UID = 501;
const agent = {kind: 'agent'} as const;
const record = (over: Partial<ResumeRecord> = {}): ResumeRecord => ({
	pid: 9,
	started: 's',
	uid: UID,
	depth: 1,
	time: 5,
	argv: ['claude', '--resume', 'x'],
	cwdSource: 'report',
	cwd: '/repo/sub',
	...over,
});

async function withRecords(...records: ResumeRecord[]) {
	const s = testState();
	const deps = {
		dao: s.daos.resumeRecords,
		repo: 'repo',
		stateDir: s.stateDir,
		uid: UID,
	};
	await deps.dao.commitLaunch('k', agent, tokenHash('seed'));
	await deps.dao.save('k', agent, 'seed', {records, times: {}});
	return {...s, deps};
}

test('a launch gets a fresh token in two private one-shot files, and the record it restores', async () => {
	const {deps} = await withRecords(record());
	const launch = preparePaneLaunch(
		{...deps, exists: () => true},
		'k',
		agent,
		'/repo',
	)!;
	expect(launch.token).toMatch(/^[\w-]{43}$/);
	for (const file of [
		launch.tokenFile,
		launch.monitorTokenFile,
		launch.restoreFile!,
	]) {
		// eslint-disable-next-line no-bitwise -- Permission bits.
		expect(statSync(file).mode & 0o777).toBe(0o600);
		// eslint-disable-next-line no-bitwise -- Permission bits.
		expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
	}
	expect(readOneShot(launch.tokenFile)).toBe(launch.token);
	expect(existsSync(launch.tokenFile)).toBe(false);
	expect(readFileSync(launch.restoreFile!, 'utf8')).toBe(
		'/repo/sub\nclaude\n--resume\nx\n',
	);
	expect(launch.restore).toStrictEqual({
		argv: ['claude', '--resume', 'x'],
		cwd: '/repo/sub',
	});
	expect(
		preparePaneLaunch({...deps, exists: () => true}, 'k', agent, '/repo')!
			.token,
	).not.toBe(launch.token);
});

test('the records stay until the pane exists, and a launch that made none keeps them', async () => {
	const {deps} = await withRecords(record());
	const failed = preparePaneLaunch(
		{...deps, exists: () => true},
		'k',
		agent,
		'/repo',
	)!;
	await finishPaneLaunch(deps, 'k', failed, false);
	expect(existsSync(failed.tokenFile) || existsSync(failed.restoreFile!)).toBe(
		false,
	);
	expect(deps.dao.read('k', agent).records).toHaveLength(1);
	const made = preparePaneLaunch(
		{...deps, exists: () => true},
		'k',
		agent,
		'/repo',
	)!;
	expect(made.restore).toBeDefined();
	await finishPaneLaunch(deps, 'k', made, true);
	expect(deps.dao.read('k', agent).records).toHaveLength(0);
	expect(
		await deps.dao.save('k', agent, made.token, {
			records: [record()],
			times: {},
		}),
	).toBe(true);
});

test('a reported directory that is gone means no restore; one read from the process falls back', async () => {
	const gone = await withRecords(record());
	expect(
		preparePaneLaunch({...gone.deps, exists: () => false}, 'k', agent, '/repo')!
			.restore,
	).toBeUndefined();
	const fromProcess = await withRecords(record({cwdSource: 'process'}));
	expect(
		preparePaneLaunch(
			{...fromProcess.deps, exists: () => false},
			'k',
			agent,
			'/repo',
		)!.restore,
	).toStrictEqual({
		argv: ['claude', '--resume', 'x'],
		cwd: '/repo',
	});
	const none = await withRecords(
		record({cwdSource: 'process', cwd: undefined}),
	);
	expect(
		preparePaneLaunch({...none.deps, exists: () => true}, 'k', agent, '/repo')!
			.restore?.cwd,
	).toBe('/repo');
});

test("root gets no token and restores nothing, and another user's record never restores", async () => {
	const {deps} = await withRecords(record({uid: 777}));
	expect(
		preparePaneLaunch({...deps, uid: 0}, 'k', agent, '/repo'),
	).toBeUndefined();
	expect(
		preparePaneLaunch({...deps, exists: () => true}, 'k', agent, '/repo')!
			.restore,
	).toBeUndefined();
});
