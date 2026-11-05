import type {SpaceData} from '../source/types.ts';
import type {ProgramStatusInfo} from '../source/program-status.ts';
import type {PipelineStatus} from '../source/providers/types.ts';

/**
 * Data a direction may show that the rail does not receive today. Kept apart
 * from SpaceData so the artifact can say which ideas need new plumbing.
 */
export type Extras = {
	/** When the current program state began (ms, scene clock). */
	stateSince?: number;
	/** Agent activity samples, oldest first, 0..1. */
	activity?: number[];
};

export type FleetSpace = SpaceData & {extras?: Extras};

/** Linear-style workflow colors, the tracker the fixture pretends to use. */
export const STATE = {
	todo: {name: 'Todo', type: 'unstarted', color: '#8a8f98'},
	inProgress: {name: 'In Progress', type: 'started', color: '#f2c94c'},
	inReview: {name: 'In Review', type: 'started', color: '#f2994a'},
	done: {name: 'Done', type: 'completed', color: '#5e6ad2'},
} as const;

type Row = {
	key: string;
	title: string;
	state: (typeof STATE)[keyof typeof STATE];
	status: ProgramStatusInfo;
	pipeline?: PipelineStatus;
	comments?: number;
	conflict?: boolean;
	emoji?: string;
	extras?: Extras;
};

const MINUTE = 60_000;

// The rail still reads the deprecated `linearIssue` alias, so fixtures fill
// both, as workspace-refresh does.
function issue(key: string, title: string, state: Row['state']) {
	const tracked = {identifier: key, title, state};
	return {linearIssue: tracked, trackerIssue: tracked};
}

function space(row: Row): FleetSpace {
	return {
		name: row.key,
		worktreePath: `/work/trattoria/${row.key}`,
		...issue(row.key, row.title, row.state),
		programStatus: row.status,
		railStatus: row.pipeline
			? {
					pipeline: row.pipeline,
					unresolvedCommentCount: row.comments ?? 0,
					hasConflict: row.conflict ?? false,
				}
			: undefined,
		profileEmoji: row.emoji ?? '',
		extras: row.extras,
	};
}

export const mainRow: FleetSpace = {
	name: 'main',
	worktreePath: '/work/trattoria',
	isMainWorktree: true,
	isDirty: false,
	programStatus: {status: 'idle', source: 'hook'},
	profileEmoji: '',
};

export const REPO = 'trattoria';

/**
 * Every row state the rail can show, in the order a real fleet might sort.
 * OSC fields (progress, message, title, app) appear only on rows whose agent
 * reports over OSC 7501; hook-driven rows carry the tool name instead.
 */
export const fleet: FleetSpace[] = [
	mainRow,
	space({
		key: 'PAP-412',
		title: 'Stream OSC progress into the rail',
		state: STATE.inProgress,
		status: {
			status: 'working',
			source: 'osc',
			app: 'claude',
			progress: 40,
			title: 'Testing',
			message: 'Running tests 12/30',
		},
		pipeline: 'progressing_clean',
		emoji: '🎨',
		extras: {
			stateSince: -6 * MINUTE,
			activity: [0.2, 0.4, 0.7, 0.9, 0.8, 1, 0.9, 0.6],
		},
	}),
	space({
		key: 'PAP-409',
		title: 'Fix flicker when the agent pane resizes',
		state: STATE.inProgress,
		status: {
			status: 'blocked',
			kind: 'question',
			source: 'hook',
			tool: 'AskUserQuestion',
		},
		emoji: '🎨',
		extras: {stateSince: -3 * MINUTE},
	}),
	space({
		key: 'PAP-405',
		title: 'Retry tracker fetch with backoff',
		state: STATE.inReview,
		status: {
			status: 'working',
			source: 'hook',
			activity: 'tool',
			tool: 'Bash',
		},
		pipeline: 'passing',
		comments: 2,
		emoji: '🔧',
		extras: {
			stateSince: -1 * MINUTE,
			activity: [0.6, 0.5, 0.7, 0.4, 0.6, 0.8, 0.7, 0.9],
		},
	}),
	space({
		key: 'PAP-401',
		title: 'Migrate config loader to Bun',
		state: STATE.inProgress,
		status: {status: 'working', source: 'hook', activity: 'compacting'},
		emoji: '🔧',
		extras: {stateSince: -2 * MINUTE},
	}),
	space({
		key: 'PAP-398',
		title: 'Speed up GitLab rail status queries',
		state: STATE.inProgress,
		status: {
			status: 'blocked',
			kind: 'permission',
			source: 'hook',
			tool: 'Bash',
		},
		pipeline: 'failing',
		conflict: true,
		emoji: '🔧',
		extras: {stateSince: -12 * MINUTE},
	}),
	space({
		key: 'PAP-396',
		title: 'Document agent profiles',
		state: STATE.inReview,
		status: {status: 'idle', source: 'hook'},
		pipeline: 'passing',
		extras: {stateSince: -25 * MINUTE},
	}),
	space({
		key: 'PAP-390',
		title: 'Close done spaces in bulk',
		state: STATE.done,
		status: {
			status: 'done',
			source: 'osc',
			app: 'codex',
			message: 'Merged !88',
		},
		pipeline: 'passing',
		extras: {stateSince: -48 * MINUTE},
	}),
	space({
		key: 'PAP-387',
		title: 'Light theme audit',
		state: STATE.inProgress,
		status: {
			status: 'error',
			source: 'osc',
			app: 'codex',
			message: 'API rate limit',
		},
		pipeline: 'progressing_dirty',
		extras: {stateSince: -4 * MINUTE},
	}),
	space({
		key: 'PAP-381',
		title: 'Handle tmux 3.6 skin tones',
		state: STATE.todo,
		status: {status: 'unknown'},
	}),
	{
		name: 'PAP-415',
		worktreePath: null,
		isPending: true,
		pendingTitle: 'Opening…',
		profileEmoji: '',
	},
];

export const pendingNewSession: FleetSpace = {
	name: '',
	worktreePath: null,
	isPending: true,
	pendingTitle: 'Starting new session…',
	profileEmoji: '',
};

export type Change = {
	at: number;
	kind: 'state' | 'message' | 'created' | 'closed' | 'progress' | 'selection';
	/** For selection changes, the row the selection left. */
	from?: string;
	/** For state changes, the row as it was just before. */
	before?: FleetSpace;
};

/** One moment of a scene: what the rail shows and when each row last changed. */
export type SceneFrame = {
	spaces: FleetSpace[];
	selected: string;
	changes: Record<string, Change>;
	/** Rows being closed stay listed until their exit animation finishes. */
	closing?: Record<string, number>;
};

export type Scene = {
	name: string;
	title: string;
	/** What the scene demonstrates, for the artifact caption. */
	caption: string;
	duration: number;
	/** When something reaches the rail, the moments the app would re-render. */
	events: number[];
	at(t: number): SceneFrame;
};

function patch(
	key: string,
	update: (space: FleetSpace) => FleetSpace,
	spaces = fleet,
): FleetSpace[] {
	return spaces.map(space => (space.name === key ? update(space) : space));
}

function spaceOf(spaces: FleetSpace[], key: string): FleetSpace {
	return spaces.find(space => space.name === key)!;
}

function withStatus(
	key: string,
	status: ProgramStatusInfo,
	since: number,
	spaces = fleet,
): FleetSpace[] {
	return patch(
		key,
		space => ({
			...space,
			programStatus: status,
			extras: {...space.extras, stateSince: since},
		}),
		spaces,
	);
}

const attention: Scene = {
	name: 'attention',
	title: 'An agent needs you',
	caption:
		'PAP-412 is working, asks a question at 1.2 s, and resumes when answered at 4.6 s.',
	duration: 6000,
	events: [1200, 4600],
	at(t): SceneFrame {
		const key = 'PAP-412';
		const working: ProgramStatusInfo = {
			status: 'working',
			source: 'osc',
			app: 'claude',
			progress: 40,
			message: 'Running tests 12/30',
		};
		const before = withStatus(key, working, -6 * MINUTE);
		if (t < 1200) return {spaces: before, selected: 'PAP-396', changes: {}};
		const blocked = withStatus(
			key,
			{
				status: 'blocked',
				kind: 'question',
				source: 'osc',
				app: 'claude',
				message: 'Which test runner?',
			},
			1200,
		);
		if (t < 4600)
			return {
				spaces: blocked,
				selected: 'PAP-396',
				changes: {
					[key]: {at: 1200, kind: 'state', before: spaceOf(before, key)},
				},
			};
		return {
			spaces: withStatus(key, working, 4600),
			selected: key,
			changes: {
				[key]: {at: 4600, kind: 'state', before: spaceOf(blocked, key)},
			},
		};
	},
};

const PROGRESS_MESSAGES = [
	[0, 'Installing dependencies'],
	[1500, 'Running tests 12/30'],
	[3000, 'Running tests 30/30'],
	[4500, 'Building release'],
] as const;

const progress: Scene = {
	name: 'progress',
	title: 'Progress over OSC 7501',
	caption:
		'PAP-412 reports progress 0 to 100 with a new message every 1.5 s, then done.',
	duration: 8000,
	// Agents report progress about twice a second.
	events: Array.from({length: 13}, (_, i) => i * 500),
	at(t): SceneFrame {
		const key = 'PAP-412';
		const pct = Math.min(100, Math.round((t / 6000) * 100));
		const [messageAt, message] = PROGRESS_MESSAGES.findLast(([at]) => t >= at)!;
		if (t >= 6000)
			return {
				spaces: withStatus(
					key,
					{status: 'done', source: 'osc', app: 'claude', message: 'Ready'},
					6000,
				),
				selected: key,
				changes: {
					[key]: {
						at: 6000,
						kind: 'state',
						before: spaceOf(
							withStatus(
								key,
								{
									status: 'working',
									source: 'osc',
									app: 'claude',
									progress: 100,
									message: 'Building release',
								},
								-6 * MINUTE,
							),
							key,
						),
					},
				},
			};
		return {
			spaces: withStatus(
				key,
				{
					status: 'working',
					source: 'osc',
					app: 'claude',
					progress: pct,
					message,
				},
				-6 * MINUTE,
			),
			selected: key,
			changes: {[key]: {at: messageAt, kind: 'message'}},
		};
	},
};

const lifecycle: Scene = {
	name: 'lifecycle',
	title: 'Rows arrive and leave',
	caption:
		'PAP-415 opens at 0.4 s and starts at 2.2 s; PAP-390 is closed at 3.6 s.',
	duration: 5600,
	events: [400, 2200, 3600],
	at(t): SceneFrame {
		const base = fleet.filter(space => space.name !== 'PAP-415');
		const changes: Record<string, Change> = {};
		let spaces = base;
		if (t >= 400) {
			const opening: FleetSpace =
				t < 2200
					? fleet.find(space => space.name === 'PAP-415')!
					: {
							name: 'PAP-415',
							worktreePath: '/work/trattoria/PAP-415',
							...issue(
								'PAP-415',
								'Add mouse wheel scrolling',
								STATE.inProgress,
							),
							programStatus: {status: 'working', source: 'hook'},
							profileEmoji: '🎨',
							extras: {stateSince: 2200},
						};
			spaces = [base[0]!, opening, ...base.slice(1)];
			changes['PAP-415'] =
				t < 2200
					? {at: 400, kind: 'created'}
					: {at: 2200, kind: 'state', before: spaceOf(fleet, 'PAP-415')};
		}

		const closing: Record<string, number> = {};
		if (t >= 3600) {
			closing['PAP-390'] = 3600;
			changes['PAP-390'] = {at: 3600, kind: 'closed'};
		}

		return {spaces, selected: 'PAP-396', changes, closing};
	},
};

const SELECT_PATH = [
	'PAP-396',
	'PAP-398',
	'PAP-401',
	'PAP-405',
	'PAP-409',
	'PAP-405',
	'PAP-401',
];

const selection: Scene = {
	name: 'selection',
	title: 'Moving the selection',
	caption: 'j/k presses every 350 ms.',
	duration: SELECT_PATH.length * 350 + 600,
	events: SELECT_PATH.map((_, index) => index * 350),
	at(t): SceneFrame {
		const index = Math.min(SELECT_PATH.length - 1, Math.floor(t / 350));
		return {
			spaces: fleet,
			selected: SELECT_PATH[index]!,
			changes: {
				selection: {
					at: index * 350,
					kind: 'selection',
					from: SELECT_PATH[Math.max(0, index - 1)],
				},
			},
		};
	},
};

export const scenes: Scene[] = [attention, progress, lifecycle, selection];

export const still: SceneFrame = {
	spaces: fleet,
	selected: 'PAP-405',
	changes: {},
};

/**
 * The fleet without rows the current rail animates on its own wall clock
 * (spinners, blink), for comparing it frame-for-frame against a terminal.
 */
export const calm: SceneFrame = {
	spaces: fleet.filter(
		space =>
			!space.isPending &&
			space.programStatus?.status !== 'working' &&
			space.programStatus?.status !== 'blocked',
	),
	selected: 'PAP-396',
	changes: {},
};

/** What the new-space prompt shows while you type a description. */
export const prompt = {
	draft: 'Add mouse wheel scrolling to the rail',
	ready: [
		{key: 'PAP-381', title: 'Handle tmux 3.6 skin tones'},
		{key: 'PAP-377', title: 'Show program status in the help legend'},
		{key: 'PAP-372', title: 'Persist the dragged rail width'},
	],
	profiles: [
		{name: 'TUI', emoji: '🎨', matched: 'rail'},
		{name: 'Backend', emoji: '🔧', isDefault: true},
		{name: 'Docs', emoji: '📝'},
	],
	/** Profile the typed words matched, which the picker preselects. */
	selectedProfile: 0,
} as const;
