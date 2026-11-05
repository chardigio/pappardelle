import type {Direction} from '../../kit/surface.ts';
import type {Change} from '../../fixtures.ts';
import {describeSpace} from '../../kit/row.ts';
import {isRunning} from '../../kit/motion.ts';
import {
	BELL,
	HEAT_INTERVAL,
	KitchenRail,
	MOVE_DURATION,
	passOrder,
	PENDING_INTERVAL,
	STAMP_DURATION,
	TEAR_DURATION,
} from './Rail.tsx';
import {
	KitchenConfirm,
	KitchenErrors,
	KitchenHelp,
	KitchenPrompt,
} from './Dialogs.tsx';
import {KitchenChrome, kitchenTmuxConf} from './Chrome.tsx';

/** Long enough for a fixture title to type in at TYPE_SPEED. */
const TYPING = 1200;

export const kitchenPass: Direction = {
	id: 'kitchen-pass',
	name: 'Kitchen pass',
	pitch:
		'Workspaces are tickets on the pass, grouped by station; the kitchen words always come with their plain meaning.',
	Rail: KitchenRail,
	Prompt: KitchenPrompt,
	Confirm: KitchenConfirm,
	Help: KitchenHelp,
	Errors: KitchenErrors,
	Chrome: KitchenChrome,
	tmuxConf: kitchenTmuxConf,
	order: passOrder,
	fps({frame, now, look}) {
		// Only changes the pass animates: selection and messages draw in place.
		const effect: Record<Change['kind'], number> = {
			state: Math.max(BELL.duration, STAMP_DURATION, MOVE_DURATION, TYPING),
			created: TYPING,
			closed: TEAR_DURATION,
			message: 0,
			progress: 0,
			selection: 0,
		};
		const transitioning = Object.values(frame.changes).some(change =>
			isRunning(now, change.at, effect[change.kind]),
		);
		if (transitioning) return 30;
		const rows = frame.spaces.map(space => describeSpace(space));
		const cooking = rows.some(row =>
			['working', 'tool', 'pending'].includes(row.state),
		);
		if (!cooking) return undefined;
		const glyphs = Math.ceil(
			1000 /
				(rows.some(row => row.state === 'pending')
					? PENDING_INTERVAL
					: HEAT_INTERVAL),
		);
		// The truecolor burner flicker needs a smoother clock than the glyph.
		return look.tier === 'truecolor' ? Math.max(15, glyphs) : glyphs;
	},
};
