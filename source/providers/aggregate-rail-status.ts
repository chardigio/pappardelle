import type {RailStatus} from './types.ts';

export function aggregateRailStatus(statuses: RailStatus[]): RailStatus {
	const prs = statuses.filter(status => status.prNumber !== undefined);
	if (prs.length === 0) return {pipeline: null, unresolvedCommentCount: 0};
	if (prs.length === 1) return {...prs[0]!};
	const progressing = prs.some(
		status =>
			status.pipeline === 'progressing_clean' ||
			status.pipeline === 'progressing_dirty',
	);
	const failing = prs.some(
		status =>
			status.pipeline === 'failing' || status.pipeline === 'progressing_dirty',
	);
	return {
		pipeline: progressing
			? failing
				? 'progressing_dirty'
				: 'progressing_clean'
			: failing
				? 'failing'
				: prs.some(status => status.pipeline !== null)
					? 'passing'
					: null,
		unresolvedCommentCount: prs.reduce(
			(count, status) => count + status.unresolvedCommentCount,
			0,
		),
		hasConflict: prs.some(status => status.hasConflict),
	};
}
