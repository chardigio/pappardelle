import type {ReactNode} from 'react';
import type {ListLayout} from '../../source/config.ts';
import type {LogEntry} from '../../source/logger.ts';
import type {SceneFrame} from '../fixtures.ts';
import type {Look} from './color.ts';

export type SurfaceProps = {
	now: number;
	look: Look;
	width: number;
	height: number;
	layout: ListLayout;
	frame: SceneFrame;
};

export type ConfirmProps = SurfaceProps & {
	/** Close space and kill-done destroy work; update and config do not. */
	destructive: boolean;
};

export type SurfaceName =
	| 'rail'
	| 'prompt'
	| 'confirm'
	| 'confirm-neutral'
	| 'help'
	| 'errors'
	| 'chrome';

export const SURFACES: SurfaceName[] = [
	'rail',
	'prompt',
	'confirm',
	'confirm-neutral',
	'help',
	'errors',
	'chrome',
];

/** Canvas size each surface is drawn at in the artifact and preview. */
export const SURFACE_SIZE: Record<
	Exclude<SurfaceName, 'rail'>,
	[number, number]
> = {
	prompt: [96, 26],
	confirm: [64, 11],
	'confirm-neutral': [64, 11],
	help: [60, 32],
	errors: [84, 16],
	chrome: [150, 34],
};

/** Tall enough for the tallest rail (Kitchen pass, two-line) with every
 * detail line showing. */
export const RAIL_HEIGHT = 34;

export type Direction = {
	id: string;
	name: string;
	/** One-line idea, used in the preview status bar and artifact. */
	pitch: string;
	Rail(props: SurfaceProps): ReactNode;
	Prompt(props: SurfaceProps): ReactNode;
	Confirm(props: ConfirmProps): ReactNode;
	Help(props: SurfaceProps): ReactNode;
	Errors(props: SurfaceProps): ReactNode;
	/** The whole tmux window: rail, agent pane, companion, pane borders. */
	Chrome(props: SurfaceProps): ReactNode;
	/** tmux options this direction would set, for the artifact snippet. */
	tmuxConf(look: Look): string;
	/**
	 * Frame rate the rail needs at this instant, or undefined when nothing on
	 * screen moves. The real app would hand this to useAnimationTick, so an
	 * idle rail costs no frames.
	 */
	fps(props: SurfaceProps): number | undefined;
	/**
	 * Frame rate an open popup needs, with `now` measured from when it opened;
	 * omitted when the popups never move.
	 */
	dialogFps?(surface: SurfaceName, props: SurfaceProps): number | undefined;
	/** Row names top to bottom, when the rail doesn't list them in fleet order. */
	order?(frame: SceneFrame): string[];
};

export const sampleErrors: LogEntry[] = [
	{
		timestamp: '2026-11-04T16:02:11.000Z',
		level: 'error',
		component: 'linear',
		message: 'Failed to fetch PAP-381',
		error: 'HTTP 503 Service Unavailable',
	},
	{
		timestamp: '2026-11-04T16:05:42.000Z',
		level: 'warn',
		component: 'gitlab',
		message: 'Rail status query hit the complexity limit, retrying in halves',
	},
	{
		timestamp: '2026-11-04T16:09:03.000Z',
		level: 'error',
		component: 'tmux',
		message: 'Cannot create agent session for PAP-415',
		error: 'no worktree found',
	},
];
