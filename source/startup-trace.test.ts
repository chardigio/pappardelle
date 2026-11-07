import test from 'ava';
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

test('startup includes the import interval and waits for pending layout plus observation', t => {
	const h = fixture();
	t.is(h.records[0]!.durationMs, 80);
	const layout = h.trace.begin('layout-request', {
		cause: 'state',
		loading: false,
		spaces: 4,
	});
	h.trace.attachmentReady();
	h.advance(400);
	t.false(h.records.some(r => r.stage === 'finished'));
	layout?.();
	h.advance(299);
	t.false(h.records.some(r => r.stage === 'finished'));
	h.advance(1);
	t.like(h.records.at(-1), {stage: 'finished', outcome: 'ok', pending: 0});
	t.like(
		h.records.find(r => r.stage === 'layout-request' && r.phase === 'end'),
		{durationMs: 400, outcome: 'ok'},
	);
});

test('work during the observation window postpones completion without another layout request', t => {
	const h = fixture();
	h.trace.attachmentReady();
	h.advance(200);
	const pass = h.trace.begin('layout-pass');
	h.advance(150);
	t.false(h.records.some(r => r.stage === 'finished'));
	pass?.();
	h.advance(300);
	t.like(h.records.at(-1), {stage: 'finished', outcome: 'ok'});
});

test('a stalled startup has a finite incomplete record and stops allocating spans', t => {
	const h = fixture();
	const end = h.trace.begin('agent-session');
	h.advance(30_000);
	t.like(h.records.at(-1), {
		stage: 'finished',
		outcome: 'incomplete',
		pending: 1,
	});
	const records = [...h.records];
	end?.();
	h.trace.attachmentReady();
	t.is(h.trace.begin('layout-pass'), undefined);
	t.deepEqual(h.records, records);
});

test('cancelled and failed spans preserve their outcomes and IDs without double finishing', t => {
	const h = fixture();
	const first = h.trace.begin('attachment');
	const second = h.trace.begin('layout-pass');
	first?.('cancelled');
	first?.('failed');
	second?.('failed');
	const ends = h.records.filter(
		r => r.stage !== 'unattributed-bootstrap' && r.phase === 'end',
	);
	t.deepEqual(
		ends.map(r => r.outcome),
		['cancelled', 'failed'],
	);
	for (const end of ends)
		t.true(
			h.records.some(
				r => r.phase === 'begin' && r.id === end.id && r.stage === end.stage,
			),
		);
	h.trace.finish();
});

test('record cap finishes incomplete even when many concurrent spans end together', t => {
	const h = fixture();
	const ends = Array.from({length: 300}, () => h.trace.begin('layout-request'));
	for (const end of ends) end?.();
	t.true(h.records.length <= 512);
	t.like(h.records.at(-1), {stage: 'finished', outcome: 'incomplete'});
	t.is(h.trace.begin('attachment'), undefined);
});

test('each process attempt gets fresh correlation and disabled tracing stays absent', t => {
	const a = fixture();
	const b = fixture();
	t.not(a.trace.launchId, b.trace.launchId);
	t.is(a.records[0]!.launchId, a.trace.launchId);
	a.trace.finish();
	b.trace.finish();
	startStartupTrace();
	t.is(startupTrace.current, undefined);
	t.deepEqual(startupSessionEnvArgs(), []);
});
