import type {Direction} from '../../kit/surface.ts';
import {describeSpace} from '../../kit/row.ts';
import {isRunning} from '../../kit/motion.ts';
import {
	BOOT_BLINK,
	CAUTION,
	CLOSE_DURATION,
	MissionRail,
	SPARK_STEP,
} from './Rail.tsx';
import {
	MissionConfirm,
	MissionErrors,
	MissionHelp,
	MissionPrompt,
} from './Dialogs.tsx';
import {MissionChrome, missionTmuxConf} from './Chrome.tsx';

export const missionControl: Direction = {
	id: 'mission-control',
	name: 'Mission control',
	pitch:
		'An instrument panel: every row carries its telemetry, the header reads the whole fleet, and a master caution calls you in.',
	Rail: MissionRail,
	Prompt: MissionPrompt,
	Confirm: MissionConfirm,
	Help: MissionHelp,
	Errors: MissionErrors,
	Chrome: MissionChrome,
	tmuxConf: missionTmuxConf,
	fps({frame, now}) {
		const rows = frame.spaces.map(space => describeSpace(space));
		const caution = rows.some(row => {
			const change = frame.changes[row.space.name];
			return (
				row.needsYou &&
				change?.kind === 'state' &&
				isRunning(now, change.at, CAUTION.duration)
			);
		});
		const closing = Object.values(frame.closing ?? {}).some(at =>
			isRunning(now, at, CLOSE_DURATION),
		);
		// The flash toggles every 300 ms; 10 fps keeps its edges on time.
		if (caution || closing) return 10;
		if (rows.some(row => row.state === 'pending')) return 1000 / BOOT_BLINK;
		const live = rows.some(row =>
			['working', 'tool', 'compacting'].includes(row.state),
		);
		return live ? 1000 / SPARK_STEP : undefined;
	},
};
