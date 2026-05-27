import test from 'ava';
import {
	classifyPipeline,
	pipelineIconCells,
	RAIL_STATUS_POLL_INTERVAL_MS,
	type CheckContext,
} from './rail-status.ts';

// ============================================================================
// classifyPipeline — CheckRun conclusions
// ============================================================================

test('classifyPipeline: empty contexts → null', t => {
	t.is(classifyPipeline([]), null);
});

test('classifyPipeline: all SUCCESS → passing', t => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
	];
	t.is(classifyPipeline(contexts), 'passing');
});

test('classifyPipeline: SUCCESS + NEUTRAL + SKIPPED → passing', t => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
		{status: 'COMPLETED', conclusion: 'NEUTRAL'},
		{status: 'COMPLETED', conclusion: 'SKIPPED'},
	];
	t.is(classifyPipeline(contexts), 'passing');
});

test('classifyPipeline: one FAILURE, rest SUCCESS → failing', t => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
		{status: 'COMPLETED', conclusion: 'FAILURE'},
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
	];
	t.is(classifyPipeline(contexts), 'failing');
});

test('classifyPipeline: TIMED_OUT counts as failing', t => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'TIMED_OUT'},
	];
	t.is(classifyPipeline(contexts), 'failing');
});

test('classifyPipeline: CANCELLED counts as failing', t => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'CANCELLED'},
	];
	t.is(classifyPipeline(contexts), 'failing');
});

test('classifyPipeline: ACTION_REQUIRED counts as failing', t => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'ACTION_REQUIRED'},
	];
	t.is(classifyPipeline(contexts), 'failing');
});

// ============================================================================
// classifyPipeline — in-progress states
// ============================================================================

test('classifyPipeline: one IN_PROGRESS, rest SUCCESS → progressing_clean', t => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
		{status: 'IN_PROGRESS'},
	];
	t.is(classifyPipeline(contexts), 'progressing_clean');
});

test('classifyPipeline: QUEUED + SUCCESS → progressing_clean', t => {
	const contexts: CheckContext[] = [
		{status: 'QUEUED'},
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
	];
	t.is(classifyPipeline(contexts), 'progressing_clean');
});

test('classifyPipeline: PENDING + SUCCESS → progressing_clean', t => {
	const contexts: CheckContext[] = [
		{status: 'PENDING'},
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
	];
	t.is(classifyPipeline(contexts), 'progressing_clean');
});

test('classifyPipeline: IN_PROGRESS + FAILURE → progressing_dirty', t => {
	const contexts: CheckContext[] = [
		{status: 'IN_PROGRESS'},
		{status: 'COMPLETED', conclusion: 'FAILURE'},
	];
	t.is(classifyPipeline(contexts), 'progressing_dirty');
});

test('classifyPipeline: QUEUED + FAILURE → progressing_dirty', t => {
	const contexts: CheckContext[] = [
		{status: 'QUEUED'},
		{status: 'COMPLETED', conclusion: 'FAILURE'},
	];
	t.is(classifyPipeline(contexts), 'progressing_dirty');
});

// ============================================================================
// classifyPipeline — StatusContext (legacy statuses, not CheckRun)
// ============================================================================

test('classifyPipeline: StatusContext SUCCESS → passing', t => {
	const contexts: CheckContext[] = [{state: 'SUCCESS'}];
	t.is(classifyPipeline(contexts), 'passing');
});

test('classifyPipeline: StatusContext FAILURE → failing', t => {
	const contexts: CheckContext[] = [{state: 'FAILURE'}];
	t.is(classifyPipeline(contexts), 'failing');
});

test('classifyPipeline: StatusContext ERROR → failing', t => {
	const contexts: CheckContext[] = [{state: 'ERROR'}];
	t.is(classifyPipeline(contexts), 'failing');
});

test('classifyPipeline: StatusContext PENDING + SUCCESS → progressing_clean', t => {
	const contexts: CheckContext[] = [{state: 'PENDING'}, {state: 'SUCCESS'}];
	t.is(classifyPipeline(contexts), 'progressing_clean');
});

test('classifyPipeline: StatusContext PENDING + FAILURE → progressing_dirty', t => {
	const contexts: CheckContext[] = [{state: 'PENDING'}, {state: 'FAILURE'}];
	t.is(classifyPipeline(contexts), 'progressing_dirty');
});

// ============================================================================
// classifyPipeline — mixed CheckRun + StatusContext
// ============================================================================

test('classifyPipeline: CheckRun SUCCESS + StatusContext SUCCESS → passing', t => {
	const contexts: CheckContext[] = [
		{status: 'COMPLETED', conclusion: 'SUCCESS'},
		{state: 'SUCCESS'},
	];
	t.is(classifyPipeline(contexts), 'passing');
});

test('classifyPipeline: CheckRun IN_PROGRESS + StatusContext FAILURE → progressing_dirty', t => {
	const contexts: CheckContext[] = [
		{status: 'IN_PROGRESS'},
		{state: 'FAILURE'},
	];
	t.is(classifyPipeline(contexts), 'progressing_dirty');
});

// ============================================================================
// pipelineIconCells — how many terminal cells the icon consumes
// ============================================================================

test('pipelineIconCells: null → 0', t => {
	t.is(pipelineIconCells(null), 0);
});

test('pipelineIconCells: passing/failing/progressing_clean → 1', t => {
	t.is(pipelineIconCells('passing'), 1);
	t.is(pipelineIconCells('failing'), 1);
	t.is(pipelineIconCells('progressing_clean'), 1);
});

test('pipelineIconCells: progressing_dirty → 2 (two-char ◐◑)', t => {
	t.is(pipelineIconCells('progressing_dirty'), 2);
});

// ============================================================================
// RAIL_STATUS_POLL_INTERVAL_MS — regression pin
// ============================================================================

// The rail-status useEffect in app.tsx issues one bulk GraphQL request per
// tick. With ~10 active workspaces that's ~6 requests/min against the 5000/hr
// personal-token rate limit. The interval was halved from 30s → 60s; this
// test pins the value so a future "tighten the loop" change has to face the
// rate-limit math before flipping it back.
test('RAIL_STATUS_POLL_INTERVAL_MS: 60 seconds (kept low-frequency to spare gh rate limits)', t => {
	t.is(RAIL_STATUS_POLL_INTERVAL_MS, 60_000);
});
