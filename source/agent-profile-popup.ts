import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {handleProfilePickerKey} from './profile-picker.ts';
import {shellQuote} from './tmux.ts';

export type AgentProfileChoice = {name: string; source: string};

/**
 * What the popup is asked to show. Handed over as a file rather than having
 * the popup load the config itself, because the popup runs in the tmux
 * server's environment and cwd, not the TUI's.
 */
export type AgentProfileRequest = {
	options: AgentProfileChoice[];
	/** Preselected row: the current override, else the profile's own agent profile. */
	selected: string;
	/** The profile's own agent profile, marked "(default)" in the list. */
	profileDefault: string;
};

export const AGENT_POPUP_MAX_VISIBLE = 16;

/** The row named '' stands for "no override" where the profile is unknown. */
export const PROFILE_AGENT_LABEL = "profile's agent";

/** Rows inside the popup besides the options: the hint line and its margin. */
const AGENT_POPUP_HINT_ROWS = 2;

/** The popup's own border. */
const AGENT_POPUP_BORDER_ROWS = 2;

/** Room for the "↑/↓ N more" rows once the list scrolls. */
const SCROLL_MARKER_ROWS = 2;

/**
 * How many options fit inside a popup `terminalRows` tall. tmux shrinks a
 * popup that doesn't fit the client, and output taller than the popup scrolls
 * its first rows out of view.
 */
export function agentPopupVisibleRows(
	optionCount: number,
	terminalRows: number,
): number {
	const room = Math.min(
		AGENT_POPUP_MAX_VISIBLE,
		terminalRows - AGENT_POPUP_HINT_ROWS,
	);
	if (optionCount <= room) return optionCount;
	return Math.max(1, room - SCROLL_MARKER_ROWS);
}

export function buildAgentProfilePopupArgs(
	cliArgv: string[],
	requestPath: string,
	resultPath: string,
	optionCount: number,
): string[] {
	const command = [...cliArgv, 'pick-agent-profile', requestPath, resultPath]
		.map(arg => shellQuote(arg))
		.join(' ');
	const height =
		Math.min(optionCount, AGENT_POPUP_MAX_VISIBLE) +
		(optionCount > AGENT_POPUP_MAX_VISIBLE ? SCROLL_MARKER_ROWS : 0) +
		AGENT_POPUP_HINT_ROWS +
		AGENT_POPUP_BORDER_ROWS;
	return [
		'display-popup',
		'-E',
		'-T',
		' Agent profile ',
		'-w',
		'60%',
		'-h',
		String(height),
		command,
	];
}

/**
 * Open the agent profile list in a tmux popup over the TUI and resolve with
 * the chosen name, or null when it was dismissed or tmux isn't there to show
 * it. `display-popup -E` returns only once the popup closes.
 */
export async function pickAgentProfileInPopup(
	request: AgentProfileRequest,
): Promise<string | null> {
	if (!process.env['TMUX'] || request.options.length === 0) return null;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-agent-'));
	const requestPath = path.join(dir, 'request.json');
	const resultPath = path.join(dir, 'result');
	try {
		fs.writeFileSync(requestPath, JSON.stringify(request));
		const args = buildAgentProfilePopupArgs(
			[process.execPath, process.argv[1] ?? 'pappardelle'],
			requestPath,
			resultPath,
			request.options.length,
		);
		await new Promise<void>(resolve => {
			const child = spawn('tmux', args, {stdio: 'ignore'});
			child.on('error', () => {
				resolve();
			});
			child.on('close', () => {
				resolve();
			});
		});
		const chosen = fs.readFileSync(resultPath, 'utf8').trim();
		return request.options.some(option => option.name === chosen)
			? chosen
			: null;
	} catch {
		return null;
	} finally {
		fs.rmSync(dir, {recursive: true, force: true});
	}
}

export function agentProfileLabel(name: string): string {
	return name || PROFILE_AGENT_LABEL;
}

/**
 * Narrow the list to the options whose label contains the query's characters
 * in order, tightest match first: `sh` finds `sol-high` ahead of
 * `sonnet-high`. Ties keep config order.
 */
export function filterAgentProfiles(
	options: AgentProfileChoice[],
	query: string,
): AgentProfileChoice[] {
	const needle = query.toLowerCase().replaceAll(/\s+/g, '');
	if (!needle) return options;

	const score = (label: string): number | undefined => {
		const haystack = label.toLowerCase();
		let position = haystack.indexOf(needle[0]!);
		if (position === -1) return undefined;
		let total = position;
		for (const char of needle.slice(1)) {
			const next = haystack.indexOf(char, position + 1);
			if (next === -1) return undefined;
			total += next - position - 1;
			position = next;
		}

		return total;
	};

	return options
		.map((option, index) => ({
			option,
			index,
			score: score(agentProfileLabel(option.name)),
		}))
		.filter(
			(
				row,
			): row is {option: AgentProfileChoice; index: number; score: number} =>
				row.score !== undefined,
		)
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.map(row => row.option);
}

/** `query` is null until `/` starts filtering. */
export type AgentPopupState = {query: string | null; index: number};

type AgentPopupKey = {
	upArrow?: boolean;
	downArrow?: boolean;
	return?: boolean;
	escape?: boolean;
	backspace?: boolean;
	delete?: boolean;
	ctrl?: boolean;
	meta?: boolean;
	tab?: boolean;
};

export type AgentPopupKeyResult = {
	state: AgentPopupState;
	action?: 'choose' | 'cancel';
};

/**
 * While filtering, every printable key is part of the query, so `j`/`k` stop
 * moving the selection and Esc leaves the filter rather than the popup.
 * `total` is the length of the list as currently filtered.
 */
export function handleAgentPopupKey(
	state: AgentPopupState,
	input: string,
	key: AgentPopupKey,
	total: number,
): AgentPopupKeyResult {
	if (state.query === null) {
		if (input === '/') return {state: {query: '', index: 0}};
		const result = handleProfilePickerKey(input, key, state.index, total);
		switch (result.action) {
			case 'move': {
				return {state: {...state, index: result.index}};
			}

			case 'submit': {
				return {state, action: 'choose'};
			}

			case 'back': {
				return {state, action: 'cancel'};
			}

			case 'agent':
			case 'ignore': {
				return {state};
			}
		}
	}

	if (key.escape) return {state: {query: null, index: 0}};
	if (key.return) return total > 0 ? {state, action: 'choose'} : {state};
	if (key.upArrow) {
		return {state: {...state, index: Math.max(0, state.index - 1)}};
	}

	if (key.downArrow) {
		return {
			state: {
				...state,
				index: Math.max(0, Math.min(total - 1, state.index + 1)),
			},
		};
	}

	if (key.backspace || key.delete) {
		return {state: {query: state.query.slice(0, -1), index: 0}};
	}

	if (input && !key.ctrl && !key.meta && !key.tab) {
		return {state: {query: state.query + input, index: 0}};
	}

	return {state};
}
