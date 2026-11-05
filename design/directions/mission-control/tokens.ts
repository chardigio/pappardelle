import {
	mix,
	terminalBackground,
	terminalForeground,
	type Look,
	type Token,
} from '../../kit/color.ts';
import type {AgentState} from '../../kit/row.ts';

/**
 * Instrument colors: cyan for live systems, amber for caution (an agent
 * needs you), red for warning (something failed), green for nominal.
 */
export const tokens = {
	live: {
		ansi: 'cyan',
		truecolor: {dark: '#5fe3d0', light: '#00796b', solarized: '#2aa198'},
	} satisfies Token,
	caution: {
		ansi: 'yellow',
		truecolor: {dark: '#ffb020', light: '#a86400', solarized: '#b58900'},
	} satisfies Token,
	warning: {
		ansi: 'red',
		truecolor: {dark: '#ff5c5c', light: '#c62828', solarized: '#dc322f'},
	} satisfies Token,
	nominal: {
		ansi: 'green',
		truecolor: {dark: '#7ee787', light: '#2e7d32', solarized: '#859900'},
	} satisfies Token,
	onAccent: {
		ansi: 'black',
		truecolor: {dark: '#101418', light: '#ffffff', solarized: '#002b36'},
	} satisfies Token,
};

export type Channel = 'live' | 'caution' | 'warning' | 'nominal' | 'quiet';

/** The four-letter readout each state shows when there's no telemetry. */
export const READOUT: Record<
	AgentState,
	{code: string; channel: Channel; meaning: string}
> = {
	working: {code: 'RUN', channel: 'live', meaning: 'working'},
	tool: {
		code: 'TOOL',
		channel: 'live',
		meaning: 'tool, by its name',
	},
	compacting: {
		code: 'COMP',
		channel: 'live',
		meaning: 'compacting context',
	},
	pending: {code: 'BOOT', channel: 'quiet', meaning: 'opening the space'},
	idle: {
		code: 'IDLE',
		channel: 'quiet',
		meaning: 'waiting for you',
	},
	done: {code: 'DONE', channel: 'nominal', meaning: 'reported done'},
	question: {code: 'ASK', channel: 'caution', meaning: 'asked you something'},
	permission: {
		code: 'PERM',
		channel: 'caution',
		meaning: 'needs permission',
	},
	error: {code: 'ERR', channel: 'warning', meaning: 'stopped on an error'},
	unknown: {code: '----', channel: 'quiet', meaning: 'no status yet'},
};

export function surfaces(look: Look) {
	const bg = terminalBackground(look.theme);
	const fg = terminalForeground(look.theme);
	const solarized = look.theme === 'solarized';
	return {
		muted: mix(fg, bg, solarized ? 0.32 : 0.45),
		grid: mix(fg, bg, solarized ? 0.6 : 0.74),
		selected: mix(bg, fg, 0.08),
		wash: (accent: string, amount: number) => mix(bg, accent, amount),
	};
}
