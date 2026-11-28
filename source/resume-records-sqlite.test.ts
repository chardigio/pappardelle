import {tokenHash} from './resume-records-sqlite.ts';
import fs from 'node:fs';
import {test, expect} from 'bun:test';
import {testState} from '../test/helpers/state.ts';
import type {ResumeRecord, ResumeState} from './program-resume.ts';
import {stateDbPath} from './state-db.ts';

const record = (pid: number, time = 10): ResumeRecord => ({
	pid,
	started: 'Fri Nov 27 03:07:41 2026',
	uid: 501,
	depth: 1,
	time,
	argv: ['claude', '--resume', 'a b', ''],
	cwd: '/repo',
	cwdSource: 'report',
});
const state = (...records: ResumeRecord[]): ResumeState => ({
	records,
	times: Object.fromEntries(records.map(each => [each.pid, each.time])),
});
const agent = {kind: 'agent'} as const;
const split = (name: string) => ({kind: 'split', name}) as const;

test("a save lands only while its token is the pane's current one", async () => {
	const {daos} = testState();
	const dao = daos.resumeRecords;
	expect(await dao.save('k', agent, tokenHash('old'), state(record(1)))).toBe(
		false,
	);
	await dao.commitLaunch('k', agent, tokenHash('old'));
	expect(await dao.save('k', agent, tokenHash('old'), state(record(1)))).toBe(
		true,
	);
	expect(dao.read('k', agent)).toStrictEqual(state(record(1)));
	await dao.commitLaunch('k', agent, tokenHash('new'));
	expect(dao.read('k', agent)).toStrictEqual({records: [], times: {}});
	expect(await dao.save('k', agent, tokenHash('old'), state(record(2)))).toBe(
		false,
	);
	expect(await dao.save('k', agent, tokenHash('new'), state(record(3)))).toBe(
		true,
	);
	expect(dao.read('k', agent).records.map(each => each.pid)).toStrictEqual([3]);
});

test('times of pids without a record are kept', async () => {
	const {daos} = testState();
	const dao = daos.resumeRecords;
	await dao.commitLaunch('k', agent, tokenHash('t'));
	await dao.save('k', agent, tokenHash('t'), {
		records: [record(1)],
		times: {1: 10, 2: 30},
	});
	expect(dao.read('k', agent).times).toStrictEqual({1: 10, 2: 30});
});

test('a split named agent is its own pane, and splits with records carry their arrangement', async () => {
	const {daos} = testState();
	const dao = daos.resumeRecords;
	await dao.commitLaunch('k', agent, tokenHash('a'));
	await dao.commitLaunch('k', split('agent'), tokenHash('s'), {
		split: 'right',
		size: '30%',
		order: 2,
	});
	await dao.commitLaunch('k', split('logs'), tokenHash('l'), {
		split: 'down',
		size: 12,
		order: 1,
	});
	await dao.commitLaunch('k', split('empty'), tokenHash('e'), {
		split: 'down',
		size: null,
		order: 3,
	});
	await dao.save('k', split('agent'), tokenHash('s'), state(record(5)));
	await dao.save('k', split('logs'), tokenHash('l'), state(record(6)));
	await dao.setArrangement('k', split('logs'), {
		split: 'down',
		size: '40%',
		order: 1,
	});
	expect(dao.read('k', agent).records).toStrictEqual([]);
	expect(dao.splitsWithRecords('k')).toStrictEqual([
		{name: 'logs', arrangement: {split: 'down', size: '40%', order: 1}},
		{name: 'agent', arrangement: {split: 'right', size: '30%', order: 2}},
	]);
});

test('remove clears one pane or the whole space, records and times with it', async () => {
	const {daos} = testState();
	const dao = daos.resumeRecords;
	for (const pane of [agent, split('x')]) {
		await dao.commitLaunch('k', pane, tokenHash('t'));
		await dao.save('k', pane, tokenHash('t'), state(record(1)));
	}
	await dao.commitLaunch('other', agent, tokenHash('t'));
	await dao.save('other', agent, tokenHash('t'), state(record(1)));
	await dao.remove('k', split('x'));
	expect(dao.splitsWithRecords('k')).toStrictEqual([]);
	expect(dao.read('k', agent).records).toHaveLength(1);
	await dao.remove('k');
	expect(dao.read('k', agent)).toStrictEqual({records: [], times: {}});
	expect(await dao.save('k', agent, tokenHash('t'), state(record(1)))).toBe(
		false,
	);
	expect(dao.read('other', agent).records).toHaveLength(1);
});

test('the state database and its directory are private to the user', async () => {
	const {daos, stateDir} = testState();
	fs.chmodSync(stateDir, 0o755);
	await daos.resumeRecords.commitLaunch('k', agent, tokenHash('t'));
	const dbPath = stateDbPath(stateDir);
	for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`])
		// eslint-disable-next-line no-bitwise -- Permission bits.
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	// eslint-disable-next-line no-bitwise -- Permission bits.
	expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
});
