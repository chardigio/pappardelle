import {test, expect} from 'bun:test';
import {
	classifyPipeline,
	pipelineIconCells,
	RAIL_STATUS_POLL_INTERVAL_MS,
	type CheckContext,
} from './rail-status.ts';

// ============================================================================
// classifyPipeline — CheckRun conclusions
// ============================================================================

test('classifyPipeline: empty contexts → null', () => {
	expect(classifyPipeline([])).toBe(null);
});

test('classifyPipeline: all SUCCESS → passing', () => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
	];
	expect(classifyPipeline(contexts)).toBe('passing');
});

test('classifyPipeline: SUCCESS + NEUTRAL + SKIPPED → passing', () => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
		{status: 'COMPLETED', conclusion: 'NEUTRAL'},
		{status: 'COMPLETED', conclusion: 'SKIPPED'},
	];
	expect(classifyPipeline(contexts)).toBe('passing');
});

test('classifyPipeline: one FAILURE, rest SUCCESS → failing', () => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
		{status: 'COMPLETED', conclusion: 'FAILURE'},
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
	];
	expect(classifyPipeline(contexts)).toBe('failing');
});

test('classifyPipeline: TIMED_OUT counts as failing', () => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'TIMED_OUT'},
	];
	expect(classifyPipeline(contexts)).toBe('failing');
});

test('classifyPipeline: CANCELLED counts as failing', () => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'CANCELLED'},
	];
	expect(classifyPipeline(contexts)).toBe('failing');
});

test('classifyPipeline: ACTION_REQUIRED counts as failing', () => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'ACTION_REQUIRED'},
	];
	expect(classifyPipeline(contexts)).toBe('failing');
});

// ============================================================================
// classifyPipeline — in-progress states
// ============================================================================

test('classifyPipeline: one IN_PROGRESS, rest SUCCESS → progressing_clean', () => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
		{status: 'IN_PROGRESS'},
	];
	expect(classifyPipeline(contexts)).toBe('progressing_clean');
});

test('classifyPipeline: QUEUED + SUCCESS → progressing_clean', () => {
	const contexts: CheckContext[] = [
		{status: 'QUEUED'},
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
	];
	expect(classifyPipeline(contexts)).toBe('progressing_clean');
});

test('classifyPipeline: PENDING + SUCCESS → progressing_clean', () => {
	const contexts: CheckContext[] = [
		{status: 'PENDING'},
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
	];
	expect(classifyPipeline(contexts)).toBe('progressing_clean');
});

test('classifyPipeline: IN_PROGRESS + FAILURE → progressing_dirty', () => {
	const contexts: CheckContext[] = [
		{status: 'IN_PROGRESS'},
		{status: 'COMPLETED', conclusion: 'FAILURE'},
	];
	expect(classifyPipeline(contexts)).toBe('progressing_dirty');
});

test('classifyPipeline: QUEUED + FAILURE → progressing_dirty', () => {
	const contexts: CheckContext[] = [
		{status: 'QUEUED'},
		{status: 'COMPLETED', conclusion: 'FAILURE'},
	];
	expect(classifyPipeline(contexts)).toBe('progressing_dirty');
});

// ============================================================================
// classifyPipeline — StatusContext (legacy statuses, not CheckRun)
// ============================================================================

test('classifyPipeline: StatusContext SUCCESS → passing', () => {
	const contexts: CheckContext[] = [{state: 'SUCCESS'}];
	expect(classifyPipeline(contexts)).toBe('passing');
});

test('classifyPipeline: StatusContext FAILURE → failing', () => {
	const contexts: CheckContext[] = [{state: 'FAILURE'}];
	expect(classifyPipeline(contexts)).toBe('failing');
});

test('classifyPipeline: StatusContext ERROR → failing', () => {
	const contexts: CheckContext[] = [{state: 'ERROR'}];
	expect(classifyPipeline(contexts)).toBe('failing');
});

test('classifyPipeline: StatusContext PENDING + SUCCESS → progressing_clean', () => {
	const contexts: CheckContext[] = [{state: 'PENDING'}, {state: 'SUCCESS'}];
	expect(classifyPipeline(contexts)).toBe('progressing_clean');
});

test('classifyPipeline: StatusContext PENDING + FAILURE → progressing_dirty', () => {
	const contexts: CheckContext[] = [{state: 'PENDING'}, {state: 'FAILURE'}];
	expect(classifyPipeline(contexts)).toBe('progressing_dirty');
});

// ============================================================================
// classifyPipeline — mixed CheckRun + StatusContext
// ============================================================================

test('classifyPipeline: CheckRun SUCCESS + StatusContext SUCCESS → passing', () => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
		{state: 'SUCCESS'},
	];
	expect(classifyPipeline(contexts)).toBe('passing');
});

test('classifyPipeline: CheckRun IN_PROGRESS + StatusContext FAILURE → progressing_dirty', () => {
	const contexts: CheckContext[] = [
		{status: 'IN_PROGRESS'},
		{state: 'FAILURE'},
	];
	expect(classifyPipeline(contexts)).toBe('progressing_dirty');
});

// ============================================================================
// pipelineIconCells — how many terminal cells the icon consumes
// ============================================================================

test('pipelineIconCells: null → 0', () => {
	expect(pipelineIconCells(null)).toBe(0);
});

test('pipelineIconCells: passing/failing/progressing_clean → 1', () => {
	expect(pipelineIconCells('passing')).toBe(1);
	expect(pipelineIconCells('failing')).toBe(1);
	expect(pipelineIconCells('progressing_clean')).toBe(1);
});

test('pipelineIconCells: progressing_dirty → 2 (two-char ◐◑)', () => {
	expect(pipelineIconCells('progressing_dirty')).toBe(2);
});

// ============================================================================
// RAIL_STATUS_POLL_INTERVAL_MS — regression pin
// ============================================================================

// The rail-status useEffect in app.tsx issues one bulk GraphQL request per
// tick. With ~10 active workspaces that's ~6 requests/min against the 5000/hr
// personal-token rate limit. The interval was halved from 30s → 60s; this
// test pins the value so a future "tighten the loop" change has to face the
// rate-limit math before flipping it back.
test('RAIL_STATUS_POLL_INTERVAL_MS: 60 seconds (kept low-frequency to spare gh rate limits)', () => {
	expect(RAIL_STATUS_POLL_INTERVAL_MS).toBe(60_000);
});
