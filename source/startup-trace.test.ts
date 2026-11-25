import {test, expect} from 'bun:test';
import {
	StartupTrace,
	type StartupRecord,
	startStartupTrace,
	startupTrace,
	startupSessionEnvArgs,
} from './startup-trace.ts';

function fixture() {
	let now = 80;
	const records: StartupRecord[] = [];
	const timers = new Set<{at: number; callback: () => void}>();
	const trace = new StartupTrace({
		pid: 123,
		now: () => now,
		write: record => records.push(record),
		schedule(callback, ms) {
			const timer = {at: now + ms, callback};
			timers.add(timer);
			return () => timers.delete(timer);
		},
	});
	return {
		trace,
		records,
		advance(ms: number) {
			now += ms;
			for (const timer of timers) {
				if (timer.at <= now && timers.delete(timer)) timer.callback();
			}
		},
	};
}

test('startup includes the import interval and waits for pending layout plus observation', () => {
	const h = fixture();
	expect(h.records[0]!.durationMs).toBe(80);
	const layout = h.trace.begin('layout-request', {
		cause: 'state',
		loading: false,
		spaces: 4,
	});
	h.trace.attachmentReady();
	h.advance(400);
	expect(h.records.some(r => r.stage === 'finished')).toBe(false);
	layout?.();
	h.advance(299);
	expect(h.records.some(r => r.stage === 'finished')).toBe(false);
	h.advance(1);
	expect(h.records.at(-1)).toMatchObject({
		stage: 'finished',
		outcome: 'ok',
		pending: 0,
	});
	expect(
		h.records.find(r => r.stage === 'layout-request' && r.phase === 'end'),
	).toMatchObject({durationMs: 400, outcome: 'ok'});
});

test('work during the observation window postpones completion without another layout request', () => {
	const h = fixture();
	h.trace.attachmentReady();
	h.advance(200);
	const pass = h.trace.begin('layout-pass');
	h.advance(150);
	expect(h.records.some(r => r.stage === 'finished')).toBe(false);
	pass?.();
	h.advance(300);
	expect(h.records.at(-1)).toMatchObject({stage: 'finished', outcome: 'ok'});
});

test('a stalled startup has a finite incomplete record and stops allocating spans', () => {
	const h = fixture();
	const end = h.trace.begin('agent-session');
	h.advance(30_000);
	expect(h.records.at(-1)).toMatchObject({
		stage: 'finished',
		outcome: 'incomplete',
		pending: 1,
	});
	const records = [...h.records];
	end?.();
	h.trace.attachmentReady();
	expect(h.trace.begin('layout-pass')).toBe(undefined);
	expect(h.records).toStrictEqual(records);
});

test('cancelled and failed spans preserve their outcomes and IDs without double finishing', () => {
	const h = fixture();
	const first = h.trace.begin('attachment');
	const second = h.trace.begin('layout-pass');
	first?.('cancelled');
	first?.('failed');
	second?.('failed');
	const ends = h.records.filter(
		r => r.stage !== 'unattributed-bootstrap' && r.phase === 'end',
	);
	expect(ends.map(r => r.outcome)).toStrictEqual(['cancelled', 'failed']);
	for (const end of ends)
		expect(
			h.records.some(
				r => r.phase === 'begin' && r.id === end.id && r.stage === end.stage,
			),
		).toBe(true);
	h.trace.finish();
});

test('record cap finishes incomplete even when many concurrent spans end together', () => {
	const h = fixture();
	const ends = Array.from({length: 300}, () => h.trace.begin('layout-request'));
	for (const end of ends) end?.();
	expect(h.records.length <= 512).toBe(true);
	expect(h.records.at(-1)).toMatchObject({
		stage: 'finished',
		outcome: 'incomplete',
	});
	expect(h.trace.begin('attachment')).toBe(undefined);
});

test('each process attempt gets fresh correlation and disabled tracing stays absent', () => {
	const a = fixture();
	const b = fixture();
	expect(a.trace.launchId).not.toBe(b.trace.launchId);
	expect(a.records[0]!.launchId).toBe(a.trace.launchId);
	a.trace.finish();
	b.trace.finish();
	startStartupTrace();
	expect(startupTrace.current).toBe(undefined);
	expect(startupSessionEnvArgs()).toStrictEqual([]);
});
