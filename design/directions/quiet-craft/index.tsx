import type {Direction} from '../../kit/surface.ts';
import {describeSpace} from '../../kit/row.ts';
import {isRunning} from '../../kit/motion.ts';
import {CLOSE_DURATION, PULSE, QuietRail, SPIN_INTERVAL} from './Rail.tsx';
import {QuietConfirm, QuietErrors, QuietHelp, QuietPrompt} from './Dialogs.tsx';
import {QuietChrome, quietTmuxConf} from './Chrome.tsx';

export const quietCraft: Direction = {
	id: 'quiet-craft',
	name: 'Quiet craft',
	pitch:
		'Hierarchy from weight and spacing; one color system; motion only when something changes.',
	Rail: QuietRail,
	Prompt: QuietPrompt,
	Confirm: QuietConfirm,
	Help: QuietHelp,
	Errors: QuietErrors,
	Chrome: QuietChrome,
	tmuxConf: quietTmuxConf,
	fps({frame, now}) {
		const rows = frame.spaces.map(space => describeSpace(space));
		const pulsing = rows.some(row => {
			const change = frame.changes[row.space.name];
			return (
				row.needsYou &&
				change?.kind === 'state' &&
				isRunning(now, change.at, PULSE.count * PULSE.period)
			);
		});
		const fading = Object.values(frame.closing ?? {}).some(at =>
			isRunning(now, at, CLOSE_DURATION),
		);
		if (pulsing || fading) return 30;
		const spinning = rows.some(row =>
			['working', 'tool', 'pending'].includes(row.state),
		);
		return spinning ? 1000 / SPIN_INTERVAL : undefined;
	},
};
