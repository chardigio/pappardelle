import type {TrackerIssue} from '../../source/providers/types.ts';
import type {SpaceData} from '../../source/types.ts';

export function trackerIssue(
	overrides: Partial<TrackerIssue> = {},
): TrackerIssue {
	return {
		identifier: 'STA-1',
		title: 'Test issue',
		state: {name: 'Todo', type: 'unstarted', color: '#fff'},
		...overrides,
	};
}

export function spaceData(
	name: string,
	overrides: Partial<SpaceData> = {},
): SpaceData {
	return {name, worktreePath: `/worktrees/${name}`, ...overrides};
}
