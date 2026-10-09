import type {ProgramStatusInfo} from './program-status.ts';
import {COLORS} from './types.ts';

export function programStatusDisplay(info?: ProgramStatusInfo): {
	color?: string;
	icon?: string;
	dim?: boolean;
} {
	if (info?.status === 'working')
		return info.activity === 'compacting'
			? {color: 'yellow', icon: '◇'}
			: {color: COLORS.CLAUDE_ORANGE};
	if (info?.status === 'idle' || info?.status === 'done')
		return {color: 'green', icon: '●'};
	if (info?.status === 'blocked')
		return info.kind === 'question'
			? {color: 'blue', icon: '?'}
			: {color: 'red', icon: '!'};
	if (info?.status === 'error') return {color: 'red', icon: '✗'};
	return {icon: '?', dim: true};
}
