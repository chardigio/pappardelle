import {test, expect} from 'bun:test';
import type {ProcessInfo, ProcessInspector} from './process-tree.ts';
import {
	chooseResumeRecord,
	ResumeRecords,
	type ResumeRecord,
	type ResumeState,
} from './program-resume.ts';

const UID = 501;
const PANE = 100;

function fakeTree(
	entries: Array<[pid: number, ppid: number, uid?: number, started?: string]>,
) {
	const tree = new Map<number, ProcessInfo>();
	for (const [pid, ppid, uid = UID, started = 'a'] of entries)
		tree.set(pid, {pid, ppid, uid, started});
	const cwds = new Map<number, string>();
	const inspector: ProcessInspector = {
		processes: () => new Map(tree),
		cwd: pid => cwds.get(pid),
	};
	return {tree, cwds, inspector};
}

function manualTimers() {
	const pending = new Set<{ms: number; run: () => void}>();
	return {
		after(ms: number, run: () => void) {
			const entry = {ms, run};
			pending.add(entry);
			return () => pending.delete(entry);
		},
		fire() {
			const due = [...pending];
			pending.clear();
			for (const entry of due) entry.run();
		},
		get pending() {
			return pending.size;
		},
	};
}

function setup(initial?: ResumeState) {
	const {tree, cwds, inspector} = fakeTree([
		[PANE, 1],
		[200, PANE],
		[300, 200],
	]);
	const timers = manualTimers();
	const saves: ResumeState[] = [];
	const records = new ResumeRecords({
		panePid: PANE,
		uid: UID,
		inspector,
		timers,
		save: state => saves.push(structuredClone(state)),
		initial,
	});
	return {tree, cwds, timers, saves, records};
}

const set = (pid: number, time: number, argv = ['vim'], cwd?: string) =>
	({type: 'set', pid, time, argv, ...(cwd ? {cwd} : {})}) as const;

test('a set from a descendant of the pane is kept with its depth and directory', () => {
	const {records, saves, cwds} = setup();
	cwds.set(300, '/work');
	expect(records.handle(set(300, 10))).toBe('accepted');
	expect(records.handle(set(200, 11, ['claude'], '/repo'))).toBe('accepted');
	expect(saves.at(-1)!.records).toStrictEqual([
		{
			pid: 300,
			started: 'a',
			uid: UID,
			depth: 2,
			time: 10,
			argv: ['vim'],
			cwd: '/work',
			cwdSource: 'process',
		},
		{
			pid: 200,
			started: 'a',
			uid: UID,
			depth: 1,
			time: 11,
			argv: ['claude'],
			cwd: '/repo',
			cwdSource: 'report',
		},
	]);
});

test("an owner that is gone, another user's or outside the pane is rejected and loses its records", () => {
	const {records, tree, saves} = setup();
	records.handle(set(300, 10));
	tree.get(300)!.uid = 0;
	expect(records.handle(set(300, 11))).toBe('rejected: owner');
	expect(saves.at(-1)!.records).toStrictEqual([]);
	tree.set(400, {pid: 400, ppid: 1, uid: UID, started: 'a'});
	expect(records.handle(set(400, 12))).toBe('rejected: owner');
	expect(records.handle(set(999, 12))).toBe('rejected: owner');
});

test('a report older than the last accepted one for its pid has no effect, whatever its kind', () => {
	const {records, saves} = setup();
	records.handle(set(200, 20, ['new']));
	const count = saves.length;
	expect(records.handle(set(200, 19, ['old']))).toBe('ignored: stale');
	expect(records.handle({type: 'clear', pid: 200, time: 19})).toBe(
		'ignored: stale',
	);
	expect(
		records.handle({type: 'rejected', reason: 'cwd', pid: 200, time: 19}),
	).toBe('ignored: stale');
	expect(saves.length).toBe(count);
	expect(records.handle(set(200, 20, ['same second']))).toBe('accepted');
});

test("clear and rejection drop the pid's record but keep its time, so an older set cannot return", () => {
	const {records, saves} = setup();
	records.handle(set(200, 20));
	expect(records.handle({type: 'clear', pid: 200, time: 21})).toBe('cleared');
	expect(saves.at(-1)).toStrictEqual({records: [], times: {200: 21}});
	expect(records.handle(set(200, 20))).toBe('ignored: stale');
	records.handle(set(200, 22));
	expect(
		records.handle({type: 'rejected', reason: 'cwd', pid: 200, time: 23}),
	).toBe('rejected: cwd');
	expect(saves.at(-1)).toStrictEqual({records: [], times: {200: 23}});
});

test('ignored reports and rejections without an owner change nothing', () => {
	const {records, saves} = setup();
	records.handle(set(200, 20));
	const count = saves.length;
	expect(records.handle({type: 'ignored', reason: 'mac'})).toBe('ignored: mac');
	expect(records.handle({type: 'rejected', reason: 'pid', time: 30})).toBe(
		'rejected: pid',
	);
	expect(saves.length).toBe(count);
});

test('an owner that exits is dropped after the grace window, a reused pid counts as exited', () => {
	const {records, tree, timers, saves} = setup();
	records.handle(set(300, 10));
	records.handle(set(200, 11));
	tree.delete(300);
	tree.get(200)!.started = 'b';
	records.checkOwners();
	records.checkOwners();
	expect(timers.pending).toBe(2);
	expect(saves.at(-1)!.records).toHaveLength(2);
	timers.fire();
	expect(saves.at(-1)!.records).toStrictEqual([]);
});

test('stopping cancels pending drops so the records outlive a dead server', () => {
	const {records, tree, timers, saves} = setup();
	records.handle(set(300, 10));
	tree.delete(300);
	records.checkOwners();
	records.stop();
	expect(timers.pending).toBe(0);
	expect(saves.at(-1)!.records).toHaveLength(1);
});

test("a monitor keeps the stored records of owners still under its pane, and drops the last run's", () => {
	const gone: ResumeRecord = {
		pid: 999,
		started: 'a',
		uid: UID,
		depth: 1,
		time: 49,
		argv: ['old'],
		cwdSource: 'report',
	};
	const stored: ResumeRecord = {
		pid: 200,
		started: 'a',
		uid: UID,
		depth: 1,
		time: 50,
		argv: ['claude'],
		cwdSource: 'report',
		cwd: '/repo',
	};
	const {records, saves} = setup({
		records: [gone, stored],
		times: {200: 50, 300: 40},
	});
	expect(records.handle(set(300, 39))).toBe('ignored: stale');
	records.handle(set(300, 41));
	expect(saves.at(-1)!.records.map(record => record.pid)).toStrictEqual([
		200, 300,
	]);
});

test("the restore picks this user's shallowest record, the latest on a tie", () => {
	const record = (
		pid: number,
		depth: number,
		time: number,
		uid = UID,
	): ResumeRecord => ({
		pid,
		started: 'a',
		uid,
		depth,
		time,
		argv: [String(pid)],
		cwdSource: 'report',
	});
	expect(
		chooseResumeRecord([record(1, 2, 9), record(2, 1, 1), record(3, 1, 5)], UID)
			?.pid,
	).toBe(3);
	expect(
		chooseResumeRecord([record(1, 0, 9, 0), record(2, 3, 1)], UID)?.pid,
	).toBe(2);
	expect(chooseResumeRecord([record(1, 0, 9, 0)], UID)).toBeUndefined();
});
