import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {rankByFuzzyMatch} from './profile-picker.ts';
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
 * Narrow the list to the agent profiles whose name (or the profile's-agent
 * label) matches the query; see rankByFuzzyMatch.
 */
export function filterAgentProfiles(
	options: AgentProfileChoice[],
	query: string,
): AgentProfileChoice[] {
	return rankByFuzzyMatch(options, query, option => [
		agentProfileLabel(option.name),
	]);
}
