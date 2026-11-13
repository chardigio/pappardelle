// Reads what an agent's TUI shows in a `capture-pane -p -e -J` capture. The
// status Pappardelle tracks says whether an agent is working or blocked; only
// the screen says what it is blocked on: the command, the subagent that asked,
// the dialog's choices, a usage limit and its reset time, or text typed into
// the input box.

import {stripVTControlCharacters} from 'node:util';

export type OptionKind = 'approve_once' | 'approve_always' | 'deny' | 'other';

export type PromptOption = {
	number: number;
	label: string;
	kind: OptionKind;
	selected: boolean;
	/** On a multi-select question: whether the option is ticked. */
	checked?: boolean;
	/** On a question: the text under the option's label. */
	description?: string;
};

export type PermissionPrompt = {
	/** The box's header, such as `Bash command` or `Edit file`. */
	tool: string;
	/** The subagent that asked, when it wasn't the main agent. */
	subagent: string | null;
	/** The line Claude shows under the header: what the command is for, or the file to edit. */
	description: string;
	/** What the tool would run or change: the command, or the diff. */
	command: string;
	question: string;
	options: PromptOption[];
	/**
	 * The prompt is taller than the agent's screen and its top is cut off:
	 * `tool`, `subagent` and `description` are unknown and `command` holds
	 * only the part shown. Claude draws on the alternate screen, so tmux keeps
	 * no scrollback to read the rest from.
	 */
	cutOff: boolean;
};

export type QuestionDialog = {
	/** Tab titles of a multi-question dialog, without the Submit tab. */
	tabs: string[];
	question: string;
	options: PromptOption[];
	/** Options are ticked with a digit or Enter, then confirmed on a Submit or Next row. */
	multiSelect: boolean;
	/**
	 * The row that takes a typed answer: the text in it ('' under its
	 * placeholder), and whether it is open for typing.
	 */
	textOption: {number: number; text: string; open: boolean} | null;
	/** The numbered row the cursor is on, free-text row included; null on Submit or Next. */
	cursor: number | null;
};

export type UsageLimit = {
	resetText: string;
	resetAt: Date | null;
	passed: boolean;
};

export type CodexDialog = {
	/**
	 * `model_switch` is the offer to move to a cheaper model that Codex shows
	 * as a limit nears; Escape keeps the current model.
	 */
	kind: 'model_switch' | 'other';
	title: string;
	/** How many numbered options it has; a table such as the hooks review has none. */
	options: number;
	/** The highlighted option, which Enter accepts. */
	selected: number | null;
};

export type AgentScreen = {
	spinner: boolean;
	permission: PermissionPrompt | null;
	question: QuestionDialog | null;
	usageLimit: UsageLimit | null;
	/** The agent's input box text, `''` when it shows only its placeholder. */
	composer: string | null;
	/** Codex's own dialogs (folder trust, model switch) that take the keyboard. */
	codexDialog: CodexDialog | null;
	lines: string[];
};

// The escape that starts an SGR style sequence in a `capture-pane -e` line.
const ESC = String.fromCodePoint(0x1b);
const RULE = /^\s*[─━]{8,}\s*$/;
const DASHED_RULE = /^\s*╌{8,}\s*$/;
const PROMPT_QUESTION = /^\s*(?:Do you want to|Would you like to) .+\?\s*$/;
const OPTION = /^\s*(❯\s*)?(\d+)\.\s+(.+?)\s*$/;
// Claude's working line: `* Caramelizing… (5s · thinking)`, and for its
// first seconds just `· Warping…`. The line after a turn, `✻ Cogitated for
// 17s · done`, has neither the timer nor the ellipsis.
const CLAUDE_SPINNER = /\(\d+[smh](?: \d+[smh])* ·|^\s*[·✢✳✶✻✽*] \S+…/;
const CODEX_SPINNER = /\bWorking \(/;
// `enter continue · esc quit`, `t trust all · enter review · esc close`.
const CODEX_DIALOG_FOOTER = /\benter \w+ · esc \w+/;
// A dialog's title is the bold line over it.
const BOLD_LINE = new RegExp(
	`^\\s*${ESC}\\[1m\\s*([^${ESC}]+?)\\s*${ESC}\\[0m\\s*$`,
);
const CODEX_OPTION = /^\s*(›\s*)?(\d+)\.\s/;
// Typing into the free-text row puts `-- INSERT -- · ` in front.
const QUESTION_FOOTER = /^\s*(?:-- INSERT -- · )?Enter to select · /;
const TYPE_SOMETHING = /^Type something\.?$/;
const CHECKBOX = /^\[([ ✔])\]\s*/;
// A bare reset time up to this far in the past is today's and has passed: a
// limit that reset at 4:28 AM, read at 5:00 AM, isn't tomorrow's.
const BARE_TIME_GRACE_MS = 6 * 60 * 60 * 1000;

function optionKind(label: string): OptionKind {
	if (label === 'Yes') return 'approve_once';
	// "Yes, and don't ask again …" and "Yes, and switch to auto mode" widen
	// what the agent may do from then on, beyond the one command shown.
	if (/^Yes\b/.test(label)) return 'approve_always';
	if (/^No\b/.test(label)) return 'deny';
	return 'other';
}

function readOptions(
	lines: string[],
	from: number,
	{joinWrapped}: {joinWrapped: boolean},
): PromptOption[] {
	const options: PromptOption[] = [];
	for (const line of lines.slice(from)) {
		if (QUESTION_FOOTER.test(line) || /^\s*Esc to cancel/.test(line)) break;
		const match = OPTION.exec(line);
		const last = options.at(-1);
		if (!match) {
			// A permission option's label wraps onto the lines under it. A
			// question's options have descriptions there instead.
			if (last && line.trim() && !RULE.test(line)) {
				if (joinWrapped) last.label = `${last.label} ${line.trim()}`;
				else
					last.description = [last.description, line.trim()]
						.filter(Boolean)
						.join(' ');
			}

			continue;
		}

		const label = match[3]!;
		options.push({
			number: Number(match[2]),
			label,
			kind: optionKind(label),
			selected: Boolean(match[1]),
		});
	}

	return options;
}

function lastIndex(
	lines: string[],
	test: (line: string, index: number) => boolean,
): number {
	for (let index = lines.length - 1; index >= 0; index--) {
		if (test(lines[index]!, index)) return index;
	}

	return -1;
}

function parsePermission(lines: string[]): PermissionPrompt | null {
	const questionAt = lastIndex(lines, line => PROMPT_QUESTION.test(line));
	if (questionAt === -1) return null;
	const options = readOptions(lines, questionAt + 1, {joinWrapped: true});
	if (options.length === 0) return null;
	const ruleAt = lastIndex(lines.slice(0, questionAt), line => RULE.test(line));
	const body = lines.slice(ruleAt + 1, questionAt);
	const boxStart = body.findIndex(line => DASHED_RULE.test(line));
	const boxEnd = lastIndex(body, line => DASHED_RULE.test(line));
	const hasBox = boxStart !== -1 && boxEnd > boxStart;
	// Claude's hints sit outside the dashed box; inside it every line is the
	// command, whatever it starts with.
	const text = (part: string[], {boxed = false} = {}) => {
		const shown = part
			.filter(
				line =>
					boxed || !/^\s*(Tip:|This command requires approval)/.test(line),
			)
			.map(line => line.replace(/^ /, '').trimEnd());
		// Claude draws a bar down the left of a command of more than one line.
		const barred =
			boxed &&
			shown.some(line => line !== '') &&
			shown.every(line => line === '' || /^│(?: |$)/.test(line));
		return (barred ? shown.map(line => line.replace(/^│ ?/, '')) : shown)
			.join('\n')
			.replace(/^\n+|\n+$/g, '');
	};
	// Claude's rule sits over the header, and its box opens below it. A
	// command's own lines can draw a rule too, so a box that only closes is
	// the surer sign. Codex draws neither.
	if ((boxEnd !== -1 && boxStart === boxEnd) || (ruleAt === -1 && hasBox)) {
		return {
			tool: '',
			subagent: null,
			description: '',
			// Without the box's top, every line above its bottom is command.
			command: text(
				hasBox
					? body.slice(boxStart + 1, boxEnd)
					: lines.slice(0, ruleAt + 1 + boxEnd),
				{boxed: true},
			),
			question: lines[questionAt]!.trim(),
			options,
			cutOff: true,
		};
	}

	const headerAt = body.findIndex(line => line.trim() !== '');
	const header = body[headerAt]?.trim() ?? '';
	const [tool, from] = header.split(' · from the ');
	return {
		tool: tool ?? header,
		subagent: from?.replace(/ agent$/, '') ?? null,
		description: text(
			body.slice(headerAt + 1, hasBox ? boxStart : headerAt + 1),
		),
		command: hasBox
			? text(body.slice(boxStart + 1, boxEnd), {boxed: true})
			: text(body.slice(headerAt + 1)),
		question: lines[questionAt]!.trim(),
		options,
		cutOff: false,
	};
}

// The tab bar of a multi-question dialog, which stays up on its last step,
// "Review your answers", whose footer differs from the questions'.
const TAB_BAR = /^\s*←.*✔ Submit\s+→\s*$/;

function parseQuestion(lines: string[]): QuestionDialog | null {
	let footerAt = lastIndex(lines, line => QUESTION_FOOTER.test(line));
	if (footerAt === -1 && lines.some(line => TAB_BAR.test(line))) {
		footerAt = lines.length;
	}

	if (footerAt === -1) return null;
	const firstOptionAt = lastIndex(lines.slice(0, footerAt), line =>
		/^\s*(❯\s*)?1\.\s/.test(line),
	);
	if (firstOptionAt === -1) return null;
	const above = (index: number) =>
		lastIndex(lines.slice(0, index), line => line.trim() !== '');
	// The question wraps onto as many lines as it needs, each drawn with a bar
	// down its left by recent Claude versions.
	const questionEnd = above(firstOptionAt);
	let questionAt = questionEnd;
	const edge = (line: string) =>
		line.trim() === '' || RULE.test(line) || TAB_BAR.test(line);
	while (questionAt > 0 && !edge(lines[questionAt - 1]!)) questionAt--;
	const question = lines
		.slice(Math.max(questionAt, 0), questionEnd + 1)
		.map(line => line.replace(/^│ ?/, '').trim())
		.join(' ');
	// The Submit step lists the answers between the tab bar and its question.
	const barAt = lastIndex(lines.slice(0, questionAt), line =>
		TAB_BAR.test(line),
	);
	const bar = lines[barAt === -1 ? above(questionAt) : barAt] ?? '';
	const tabs = bar
		.replace(/^\s*←|→\s*$/g, '')
		.split(/\s{2,}/)
		.map(tab => tab.trim().replace(/^[☐☒✔]\s*/, ''))
		.filter(tab => tab !== '' && tab !== 'Submit');
	const typing = lines[footerAt]?.includes('-- INSERT --') ?? false;
	const all = readOptions(lines, firstOptionAt, {joinWrapped: false});
	// Claude puts the free-text row right above "Chat about this", and shows
	// what's typed in it in place of its label, focused or not. The review
	// step has neither.
	const chat = all.find(option => option.label === 'Chat about this');
	const rows = all
		.filter(option => option !== chat)
		.map(option => {
			const box = CHECKBOX.exec(option.label);
			return box
				? {
						...option,
						label: option.label.slice(box[0].length),
						checked: box[1] === '✔',
					}
				: option;
		});
	const text = chat
		? rows.find(option => option.number === chat.number - 1)
		: undefined;
	return {
		tabs,
		question,
		options: rows.filter(option => option !== text),
		multiSelect: rows.some(option => option.checked !== undefined),
		cursor: rows.find(option => option.selected)?.number ?? null,
		textOption: text
			? {
					number: text.number,
					text: TYPE_SOMETHING.test(text.label) ? '' : text.label,
					open: typing && text.selected,
				}
			: null,
	};
}

const MONTHS = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec',
];

function hours24(hour: string, meridiem: string): number {
	return (Number(hour) % 12) + (meridiem.toUpperCase() === 'PM' ? 12 : 0);
}

/** Codex shows a bare `4:28 AM`, or a date when the reset is days away. */
export function parseResetTime(text: string, now: Date): Date | null {
	const dated =
		/^([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) (\d{1,2}):(\d{2}) ([AP]M)$/i.exec(
			text,
		);
	if (dated) {
		const month = MONTHS.indexOf(dated[1]!);
		if (month === -1) return null;
		return new Date(
			Number(dated[3]),
			month,
			Number(dated[2]),
			hours24(dated[4]!, dated[6]!),
			Number(dated[5]),
		);
	}

	const bare = /^(\d{1,2}):(\d{2}) ([AP]M)$/i.exec(text);
	if (!bare) return null;
	const reset = new Date(now);
	reset.setHours(hours24(bare[1]!, bare[3]!), Number(bare[2]), 0, 0);
	if (now.getTime() - reset.getTime() > BARE_TIME_GRACE_MS) {
		reset.setDate(reset.getDate() + 1);
	}

	return reset;
}

function parseUsageLimit(lines: string[], now: Date): UsageLimit | null {
	// Codex starts the notice at the left edge with its error mark; the same
	// words elsewhere, say in a file an agent prints, aren't a limit.
	const limitAt = lastIndex(
		lines,
		line => line.startsWith('■ ') && line.includes('hit your usage limit'),
	);
	if (limitAt === -1) return null;
	// Once the agent works again, an old limit message scrolls up above it.
	if (lastIndex(lines, line => line.startsWith('• ')) > limitAt) return null;
	const joined = lines.slice(limitAt).join(' ').replace(/\s+/g, ' ');
	const resetText =
		/try again at (.*?\d{1,2}:\d{2} ?[AP]M)/i.exec(joined)?.[1] ?? '';
	const resetAt = resetText ? parseResetTime(resetText, now) : null;
	return {
		resetText,
		resetAt,
		passed: resetAt !== null && now.getTime() >= resetAt.getTime(),
	};
}

/** The input line: Codex's `›`, or Claude's `❯` boxed between two rules. */
function composerLine(lines: string[]): {at: number; glyph: string} | null {
	const codex = lastIndex(lines, line => line.startsWith('› ') || line === '›');
	const claude = lastIndex(
		lines,
		(line, index) => line.startsWith('❯') && RULE.test(lines[index - 1] ?? ''),
	);
	if (codex === -1 && claude === -1) return null;
	return codex > claude ? {at: codex, glyph: '›'} : {at: claude, glyph: '❯'};
}

function parseComposer(raw: string[], lines: string[]): string | null {
	const input = composerLine(lines);
	if (!input) return null;
	const {at, glyph} = input;
	// Both agents draw their placeholder dim; typed text is plain.
	const line = raw[at]!;
	let afterPrompt = line.slice(line.indexOf(glyph) + 1);
	if (afterPrompt.startsWith(`${ESC}[0m`)) afterPrompt = afterPrompt.slice(4);
	if (/^[ \u00A0]/.test(afterPrompt)) afterPrompt = afterPrompt.slice(1);
	if (afterPrompt.startsWith(`${ESC}[2m`)) return '';
	const draft = [lines[at]!.slice(lines[at]!.indexOf(glyph) + 1)];
	if (glyph === '❯') {
		// A long Claude draft wraps onto more lines inside the box.
		for (const next of lines.slice(at + 1)) {
			if (RULE.test(next)) break;
			draft.push(next);
		}
	}

	return draft
		.map(text => text.trim())
		.filter(Boolean)
		.join('\n');
}

function parseCodexDialog(raw: string[], lines: string[]): CodexDialog | null {
	const footer = lastIndex(lines, line => CODEX_DIALOG_FOOTER.test(line));
	if (footer === -1) return null;
	const body = lines.slice(0, footer);
	const firstOption = body.findIndex(line => /^\s*(?:› )?1\. /.test(line));
	const firstHighlight = body.findIndex(line => line.startsWith('›'));
	const top =
		firstOption === -1
			? firstHighlight === -1
				? footer
				: firstHighlight
			: firstOption;
	const above = lines
		.slice(0, top)
		.map(line => line.trim())
		.filter(Boolean);
	const boldAt = lastIndex(raw.slice(0, top), line => BOLD_LINE.test(line));
	const title =
		boldAt === -1 ? (above.at(-1) ?? '') : BOLD_LINE.exec(raw[boldAt]!)![1]!;
	const options = body
		.slice(top)
		.map(line => CODEX_OPTION.exec(line))
		.filter(match => match !== null);
	const selected = options.find(match => match[1]);
	return {
		kind: above.some(line => line === 'Approaching rate limits')
			? 'model_switch'
			: 'other',
		title,
		options: options.length,
		selected: selected ? Number(selected[2]) : null,
	};
}

export function parseAgentScreen(capture: string, now: Date): AgentScreen {
	const raw = capture.replace(/\n+$/, '').split('\n');
	const lines = raw.map(line => stripVTControlCharacters(line));
	const codexDialog = parseCodexDialog(raw, lines);
	return {
		spinner: lines.some(
			line => CLAUDE_SPINNER.test(line) || CODEX_SPINNER.test(line),
		),
		permission: parsePermission(lines),
		question: parseQuestion(lines),
		usageLimit: parseUsageLimit(lines, now),
		composer: codexDialog ? null : parseComposer(raw, lines),
		codexDialog,
		lines,
	};
}
