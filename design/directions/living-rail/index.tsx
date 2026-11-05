import type {Direction} from '../../kit/surface.ts';
import type {Change} from '../../fixtures.ts';
import {describeSpace} from '../../kit/row.ts';
import {isRunning} from '../../kit/motion.ts';
import {COLLAPSE, GLIDE, LivingRail, SHIMMER, SLIDE_IN} from './Rail.tsx';
import {
	ERROR_GLOW,
	LivingConfirm,
	LivingErrors,
	LivingHelp,
	LivingPrompt,
	OPEN_DURATION,
} from './Dialogs.tsx';
import {LivingChrome, livingTmuxConf} from './Chrome.tsx';

export const livingRail: Direction = {
	id: 'living-rail',
	name: 'Living rail',
	pitch:
		'Motion carries meaning: things that are alive move, new output glints, progress fills the row.',
	Rail: LivingRail,
	Prompt: LivingPrompt,
	Confirm: LivingConfirm,
	Help: LivingHelp,
	Errors: LivingErrors,
	Chrome: LivingChrome,
	tmuxConf: livingTmuxConf,
	// Popups open with an expand. Errors then settle once the newest entry's
	// glow fades; the others keep a sheen or spinner moving.
	dialogFps(surface, {look, now}) {
		if (surface === 'errors' && now > OPEN_DURATION + ERROR_GLOW)
			return undefined;
		return look.tier === 'truecolor' ? 30 : 12;
	},
	fps({frame, now, look}) {
		// Each kind of change runs only as long as its own effect.
		const effect: Record<Change['kind'], number> = {
			selection: GLIDE,
			message: SHIMMER,
			state: SHIMMER,
			created: SLIDE_IN,
			closed: COLLAPSE,
			progress: 0,
		};
		if (
			Object.values(frame.changes).some(change =>
				isRunning(now, change.at, effect[change.kind]),
			)
		)
			return 60;
		const rows = frame.spaces.map(space => describeSpace(space));
		const alive = rows.some(row =>
			['working', 'tool', 'pending', 'question', 'permission'].includes(
				row.state,
			),
		);
		const breathing =
			look.tier === 'truecolor' && rows.some(row => row.state === 'compacting');
		if (alive || breathing) return look.tier === 'truecolor' ? 30 : 12;
		return undefined;
	},
};
