/**
 * Pure helpers for the rail-status column (pipeline icon + unresolved comment count).
 *
 * `classifyPipeline` turns a PR's raw CheckRun/StatusContext list into a
 * single `PipelineStatus` for rendering. Kept intentionally framework-free so
 * it can be unit-tested with fixture data (no gh CLI, no network).
 */

import type {PipelineStatus} from './providers/types.ts';

export type {PipelineStatus, RailStatus} from './providers/types.ts';

/**
 * How often app.tsx's rail-status useEffect issues its bulk GraphQL request.
 *
 * Each tick is one aliased `pullRequests` query covering every active
 * workspace, so the cost scales with the *number of ticks*, not the number
 * of workspaces. At 60s a ten-workspace desk burns ~60 requests/hour
 * against gh's 5000/hr personal-token limit — comfortably under, and leaves
 * headroom for the synchronous PR-lookup the watchlist also makes.
 *
 * Lives next to `classifyPipeline` so the regression test can import it
 * without pulling in app.tsx's Ink/React surface.
 */
export const RAIL_STATUS_POLL_INTERVAL_MS = 60_000;

/**
 * A single pipeline check, as returned by GitHub's statusCheckRollup.
 * - CheckRun rows have {status, conclusion}
 * - StatusContext rows have {state}
 * Both shapes are accepted; callers pass whichever fields GitHub returned.
 */
export interface CheckContext {
	status?: string; // CheckRun: QUEUED | IN_PROGRESS | COMPLETED | WAITING | PENDING | REQUESTED
	conclusion?: string | null; // CheckRun: SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | ACTION_REQUIRED | STARTUP_FAILURE | STALE
	state?: string; // StatusContext: EXPECTED | ERROR | FAILURE | PENDING | SUCCESS
}

const FAILING_CONCLUSIONS = new Set([
	'FAILURE',
	'CANCELLED',
	'TIMED_OUT',
	'ACTION_REQUIRED',
	'STARTUP_FAILURE',
]);

const FAILING_STATES = new Set(['FAILURE', 'ERROR']);

const IN_PROGRESS_STATUSES = new Set([
	'QUEUED',
	'IN_PROGRESS',
	'PENDING',
	'WAITING',
	'REQUESTED',
]);

const IN_PROGRESS_STATES = new Set(['PENDING', 'EXPECTED']);

export function classifyPipeline(
	contexts: readonly CheckContext[],
): PipelineStatus | null {
	if (contexts.length === 0) return null;

	let anyInProgress = false;
	let anyFailing = false;

	for (const ctx of contexts) {
		if (ctx.status !== undefined) {
			if (ctx.status !== 'COMPLETED' && IN_PROGRESS_STATUSES.has(ctx.status)) {
				anyInProgress = true;
				continue;
			}

			if (ctx.conclusion && FAILING_CONCLUSIONS.has(ctx.conclusion)) {
				anyFailing = true;
			}

			continue;
		}

		if (ctx.state !== undefined) {
			if (IN_PROGRESS_STATES.has(ctx.state)) {
				anyInProgress = true;
				continue;
			}

			if (FAILING_STATES.has(ctx.state)) {
				anyFailing = true;
			}
		}
	}

	if (anyInProgress) {
		return anyFailing ? 'progressing_dirty' : 'progressing_clean';
	}

	return anyFailing ? 'failing' : 'passing';
}

/**
 * How many terminal cells the pipeline icon occupies.
 * The "progressing with some failures" state is rendered as the two-char
 * sequence "◐◑" — yellow left-half + red right-half — so callers reserve
 * 2 cells for that state.
 */
export function pipelineIconCells(pipeline: PipelineStatus | null): number {
	if (!pipeline) return 0;
	return pipeline === 'progressing_dirty' ? 2 : 1;
}

/**
 * ASCII-friendly single-token rendering of the pipeline icon for tests and
 * for callers that don't need the two-color treatment (the real UI renders
 * `progressing_dirty` as two separately-colored <Text> spans).
 */
export function pipelineIconToken(pipeline: PipelineStatus | null): string {
	if (pipeline === null) return '';
	switch (pipeline) {
		case 'passing': {
			return '✓'; // ✓
		}

		case 'failing': {
			return '✗'; // ✗
		}

		case 'progressing_clean': {
			return '◔'; // ◔
		}

		case 'progressing_dirty': {
			return '◐◑'; // ◐◑
		}
	}
}
