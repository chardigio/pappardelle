import {
	mix,
	terminalBackground,
	terminalForeground,
	type Look,
	type Token,
} from '../../kit/color.ts';
import type {AgentState} from '../../kit/row.ts';

export const tokens = {
	heat: {
		ansi: 'yellow',
		truecolor: {dark: '#ffb454', light: '#b86a00', solarized: '#cb4b16'},
	} satisfies Token,
	heatHot: {
		ansi: 'yellow',
		truecolor: {dark: '#ffd27a', light: '#d4880f', solarized: '#b58900'},
	} satisfies Token,
	question: {
		ansi: 'blue',
		truecolor: {dark: '#7aa7ff', light: '#2f5bd3', solarized: '#268bd2'},
	} satisfies Token,
	permission: {
		ansi: 'red',
		truecolor: {dark: '#ff7a85', light: '#c4314b', solarized: '#dc322f'},
	} satisfies Token,
	plated: {
		ansi: 'green',
		truecolor: {dark: '#8fd18a', light: '#2f7d32', solarized: '#859900'},
	} satisfies Token,
	burnt: {
		ansi: 'red',
		truecolor: {dark: '#ff6b6b', light: '#c62828', solarized: '#dc322f'},
	} satisfies Token,
	reduce: {
		ansi: 'magenta',
		truecolor: {dark: '#c792ea', light: '#8e44ad', solarized: '#6c71c4'},
	} satisfies Token,
	marker: {
		ansi: 'yellow',
		truecolor: {dark: '#ffb454', light: '#b86a00', solarized: '#b58900'},
	} satisfies Token,
	onAccent: {
		ansi: 'black',
		truecolor: {dark: '#16181d', light: '#ffffff', solarized: '#002b36'},
	} satisfies Token,
};

/** Kitchen word for each agent state, with what it means in plain terms. */
export const STATIONS: Record<
	AgentState,
	{word: string; meaning: string; token?: keyof typeof tokens}
> = {
	working: {word: 'FIRE', meaning: 'working', token: 'heat'},
	tool: {word: 'FIRE', meaning: 'running a tool', token: 'heat'},
	pending: {word: 'PRINT', meaning: 'opening the workspace'},
	compacting: {
		word: 'REDUCE',
		meaning: 'compacting its context',
		token: 'reduce',
	},
	idle: {word: 'HOLD', meaning: 'idle, waiting for your next message'},
	done: {word: 'PLATED', meaning: 'reported done', token: 'plated'},
	question: {word: 'CHEF?', meaning: 'asked you a question', token: 'question'},
	permission: {
		word: 'SIGN',
		meaning: 'needs your permission',
		token: 'permission',
	},
	error: {word: 'BURNT', meaning: 'stopped on an error', token: 'burnt'},
	unknown: {word: '—', meaning: 'no agent status yet'},
};

export type Group = 'calling' | 'firing' | 'pass' | 'burnt' | 'cold';

export const GROUPS: Array<{id: Group; label: string; states: AgentState[]}> = [
	{id: 'calling', label: 'calling', states: ['question', 'permission']},
	{
		id: 'firing',
		label: 'firing',
		states: ['working', 'tool', 'compacting', 'pending'],
	},
	{id: 'pass', label: 'on the pass', states: ['idle', 'done']},
	{id: 'burnt', label: '86', states: ['error']},
	{id: 'cold', label: 'cold', states: ['unknown']},
];

export function surfaces(look: Look) {
	const bg = terminalBackground(look.theme);
	const fg = terminalForeground(look.theme);
	const paper = look.theme === 'light' ? '#c9a46a' : '#f3e3c3';
	return {
		muted: mix(fg, bg, look.theme === 'solarized' ? 0.32 : 0.45),
		rule: mix(fg, bg, look.theme === 'solarized' ? 0.55 : 0.68),
		/** Selected ticket: a warm paper tint over the terminal background. */
		ticket: mix(bg, paper, look.theme === 'light' ? 0.16 : 0.09),
		wash(accent: string, amount: number) {
			return mix(bg, accent, amount);
		},
	};
}
