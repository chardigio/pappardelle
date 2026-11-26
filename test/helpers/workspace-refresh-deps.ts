import type {WorkspaceRefreshDeps} from '../../source/workspace-refresh.ts';

/** No spaces, every agent idle, the main worktree at /repo on main. */
export function workspaceRefreshDeps(
	overrides: Partial<WorkspaceRefreshDeps> = {},
): WorkspaceRefreshDeps {
	return {
		readRegistry: async () => [],
		statusReader: () => async () => ({status: 'idle'}),
		readWorktreePath: async key => `/worktrees/${key}`,
		readMainWorktree: async () => ({path: '/repo', branch: 'main'}),
		readDirty: async () => false,
		statusKey: async key => key,
		getCachedIssue: () => null,
		async fetchIssues() {},
		readEmoji: async () => undefined,
		setSpaces() {},
		onLoaded() {},
		onError(error) {
			throw error;
		},
		...overrides,
	};
}
