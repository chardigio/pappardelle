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
	/** On a Codex prompt: the key that picks it, wherever the highlight is. */
	shortcut?: string;
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
	 * How an option is chosen: Claude takes its digit, Codex the key shown at
	 * the end of its label. A digit on Codex only moves the highlight.
	 */
	choose: 'digit' | 'shortcut';
	/** The files a Codex patch would change, as absolute paths. */
	files?: string[];
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
	 * placeholder), whether it is open for typing, and the key that closes it
	 * when different from Claude's `Up`.
	 */
	textOption: {
		number: number;
		text: string;
		open: boolean;
		closeKey?: 'Escape';
	} | null;
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
	/**
	 * The agent's input box text, `''` when it shows only its placeholder, and
	 * null while a dialog is open. A command typed in Claude's shell mode starts
	 * with `!`.
	 */
	composer: string | null;
	/**
	 * Claude's input box is in shell mode (`!`), where Enter runs the box as a
	 * shell command. Clearing the box leaves it.
	 */
	shellMode: boolean;
	/** Agy's `>` input box, whose vim normal mode ignores readline clear keys. */
	agyComposer: boolean;
	/** Codex's own dialogs (folder trust, model switch) that take the keyboard. */
	codexDialog: CodexDialog | null;
	/** Agy modal dialogs (such as the subagent approval view) that take the keyboard. */
	agyDialog: boolean;
	/** The screen as text, with the input box's dim placeholder left out. */
	lines: string[];
};

// The escape that starts an SGR style sequence in a `capture-pane -e` line.
const ESC = String.fromCodePoint(0x1b);
const RULE = /^\s*[─━]{8,}\s*$/;
// Claude names the session inside the rule over its input box:
// `──────── pappardelle-061n ─`.
const INPUT_RULE = /^\s*[─━]{8,}/;
const DASHED_RULE = /^\s*╌{8,}\s*$/;
const PROMPT_QUESTION = /^\s*(?:Do you want to|Would you like to) .+\?\s*$/;
const OPTION = /^\s*(❯\s*)?(\d+)\.\s+(.+?)\s*$/;
// Claude's working line: `* Caramelizing… (5s · thinking)`, and for its
// first seconds just `· Warping…`. The line after a turn, `✻ Cogitated for
// 17s · done`, has neither the timer nor the ellipsis.
const CLAUDE_SPINNER = /\(\d+[smh](?: \d+[smh])* ·|^\s*[·✢✳✶✻✽*] \S+…/;
const CODEX_SPINNER = /\bWorking \(/;
// `enter continue · esc quit`, `t trust all · enter review · esc close`.
// Agy's question and subagent-manage footers also pair `enter <word> · esc <word>`,
// so match only Codex's lowercase verb set.
const CODEX_DIALOG_FOOTER =
	/^\s*(?:[a-z ]+ · )?enter (?:continue|confirm|review|select) · esc (?:quit|skip|close|back)\s*$/;
// A dialog's title is the bold line over it.
const BOLD_LINE = new RegExp(
	`^\\s*${ESC}\\[1m\\s*([^${ESC}]+?)\\s*${ESC}\\[0m\\s*$`,
);
const CODEX_OPTION = /^\s*(›\s*)?(\d+)\.\s/;
// Typing into the free-text row puts `-- INSERT -- · ` in front.
const QUESTION_FOOTER = /^\s*(?:-- INSERT -- · )?Enter to select · /;
const AGY_QUESTION_FOOTER =
	/^\s*↑\/↓ Navigate · enter (?:Select|Write-in) · esc Skip\s*$/;
const AGY_WRITE_IN_FOOTER = /^\s*enter Submit · esc Back\s*$/;
const AGY_YOUR_ANSWER = /^\s*Your answer:\s*$/;
const AGY_MANAGE_FOOTER =
	/^\s*↑\/↓ navigate · \/ select · enter confirm · esc cancel\s*$/;
// Lowercase `esc to cancel` followed by spaces/EOL matches agy's footer, not
// Claude's `Esc to cancel · Tab to amend`; model lines require agy's effort
// suffix or `auto ·` prefix rather than Codex's `<model> · <path>`.
const AGY_STATUS_FOOTER =
	/^\s*(?:--\s+INSERT\s+--\s+)?(?:\?\s+for\s+shortcuts\s+)?(?:(?:auto|plan|manual|default|accept edits)\s+·\s+)?(?:Gemini|Claude|GPT)\b.*·\s*(?:minimal|low|medium|high)\b(?:\s+·\s+\d+\s+subagent\(s\))?\s*$/;
const AGY_BOTTOM_LINE = new RegExp(
	String.raw`^\s*esc to cancel(?:\s{2,}|$)|${AGY_STATUS_FOOTER.source}`,
);
const AGY_OPTION = /^\s*(>\s*)?(\d+)\.\s+(.+?)\s*$/;
const AGY_WRITE_IN = /^Write-in(?:\.\.\.|:\s*(.+))$/;
const TYPE_SOMETHING = /^Type something\.?$/;
const CHECKBOX = /^\[([ ✔])\]\s*/;
// A bare reset time up to this far in the past is today's and has passed: a
// limit that reset at 4:28 AM, read at 5:00 AM, isn't tomorrow's.
const BARE_TIME_GRACE_MS = 6 * 60 * 60 * 1000;

function optionKind(label: string): OptionKind {
	if (label === 'Yes' || label === 'Yes, proceed') return 'approve_once';
	// "Yes, and don't ask again …" and "Yes, and switch to auto mode" widen
	// what the agent may do from then on, beyond the one command shown.
	if (/^Yes\b/.test(label)) return 'approve_always';
	if (/^No\b/.test(label)) return 'deny';
	return 'other';
}

function isOptionStop(line: string): boolean {
	return (
		QUESTION_FOOTER.test(line) ||
		AGY_QUESTION_FOOTER.test(line) ||
		AGY_WRITE_IN_FOOTER.test(line) ||
		AGY_YOUR_ANSWER.test(line) ||
		/^\s*Esc to cancel/.test(line)
	);
}

function readOptions(
	lines: string[],
	from: number,
	{
		joinWrapped,
		optionPattern = OPTION,
	}: {
		joinWrapped: boolean;
		optionPattern?: RegExp;
	},
): PromptOption[] {
	const options: PromptOption[] = [];
	for (const line of lines.slice(from)) {
		if (isOptionStop(line)) break;
		const match = optionPattern.exec(line);
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
	lines: readonly string[],
	test: (line: string, index: number) => boolean,
): number {
	for (let index = lines.length - 1; index >= 0; index--) {
		if (test(lines[index]!, index)) return index;
	}

	return -1;
}

const CODEX_APPROVAL =
	/^\s*Would you like to (run the following command|make the following edits)\?\s*$/;
const CODEX_APPROVAL_FOOTER = /^\s*Press enter to confirm or esc to cancel/;
// Codex ends each option with the key that picks it: `(y)`, `(esc)`.
const CODEX_SHORTCUT = /\s*\((\w+)\)$/;

/**
 * Codex's approval prompt: a bold question, the command after `$` or the
 * files after `Destination:`, and options chosen by their own keys. A command
 * that can't be found reads as empty, which no policy approves.
 */
function parseCodexApproval(lines: string[]): PermissionPrompt | null {
	const footerAt = lastIndex(lines, line => CODEX_APPROVAL_FOOTER.test(line));
	// The live prompt is the bottom of the pane; one higher up is scrollback.
	if (footerAt === -1 || lines.slice(footerAt + 1).some(line => line.trim()))
		return null;
	const questionAt = lastIndex(lines.slice(0, footerAt), line =>
		CODEX_APPROVAL.test(line),
	);
	if (questionAt === -1) return null;
	const body = lines.slice(questionAt + 1, footerAt);
	const firstOption = body.findIndex(line => /^\s*(?:›\s*)?1\.\s/.test(line));
	if (firstOption === -1) return null;
	const details = body.slice(0, firstOption);
	const options: PromptOption[] = [];
	for (const line of body.slice(firstOption)) {
		const match = /^\s*(›\s*)?(\d+)\.\s+(.+?)\s*$/.exec(line);
		if (match) {
			const shortcut = CODEX_SHORTCUT.exec(match[3]!)?.[1];
			const label = match[3]!.replace(CODEX_SHORTCUT, '');
			options.push({
				number: Number(match[2]),
				label,
				kind: optionKind(label),
				selected: Boolean(match[1]),
				...(shortcut ? {shortcut} : {}),
			});
		} else if (line.trim() && options.length > 0) {
			// A label wraps onto the lines under it in a narrow pane, its key last.
			const last = options.at(-1)!;
			const joined = `${last.label} ${line.trim()}`;
			const shortcut = CODEX_SHORTCUT.exec(joined)?.[1];
			last.label = joined.replace(CODEX_SHORTCUT, '');
			last.kind = optionKind(last.label);
			if (shortcut) last.shortcut = shortcut;
		}
	}

	// Each field runs on to the next blank line, wrapped in a narrow pane.
	const field = (name: string) =>
		details.flatMap((line, index) => {
			if (!line.trimStart().startsWith(`${name}:`)) return [];
			const end = details.findIndex(
				(next, at) => at > index && (!next.trim() || /^\s*\w+:/.test(next)),
			);
			return [
				details
					.slice(index, end === -1 ? undefined : end)
					.map(part => part.trim())
					.join(' ')
					.slice(name.length + 1)
					.trim(),
			];
		});
	const isCommand = CODEX_APPROVAL.exec(lines[questionAt]!)![1]!.startsWith(
		'run',
	);
	const commandAt = details.findIndex(line => /^\s*\$ /.test(line));
	const command: string[] = [];
	// The command runs to the options, blank lines and all.
	if (isCommand && commandAt !== -1) {
		for (const line of details.slice(commandAt))
			command.push(line.replace(/^\s*(?:\$ )?/, '').trimEnd());
		while (command.at(-1) === '') command.pop();
	}

	const files = isCommand ? undefined : field('Destination');
	return {
		tool: isCommand ? 'Bash command' : 'Codex edits',
		subagent: null,
		description: (isCommand ? field('Reason') : field('Description')).join(' '),
		command: isCommand ? command.join('\n') : (files ?? []).join('\n'),
		question: lines[questionAt]!.trim(),
		options,
		choose: 'shortcut',
		...(files ? {files} : {}),
		cutOff: false,
	};
}

function parsePermission(lines: string[]): PermissionPrompt | null {
	const codex = parseCodexApproval(lines);
	if (codex) return codex;
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
			choose: 'digit',
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
		choose: 'digit',
		cutOff: false,
	};
}

// The tab bar of a multi-question dialog, which stays up on its last step,
// "Review your answers", whose footer differs from the questions'.
const TAB_BAR = /^\s*←.*✔ Submit\s+→\s*$/;

function withCheckboxes(options: PromptOption[]): PromptOption[] {
	return options.map(option => {
		const box = CHECKBOX.exec(option.label);
		return box
			? {
					...option,
					label: option.label.slice(box[0].length),
					checked: box[1] === '✔',
				}
			: option;
	});
}

function isAgyBottomAnchored(
	lines: readonly string[],
	footerAt: number,
): boolean {
	return lines
		.slice(footerAt + 1)
		.every(line => !line.trim() || AGY_BOTTOM_LINE.test(line));
}

function parseAgyDialog(lines: string[]): boolean {
	const footerAt = lastIndex(lines, line => AGY_MANAGE_FOOTER.test(line));
	return footerAt !== -1 && isAgyBottomAnchored(lines, footerAt);
}

function parseAgyQuestion(lines: string[]): QuestionDialog | null {
	const footerAt = lastIndex(
		lines,
		line => AGY_QUESTION_FOOTER.test(line) || AGY_WRITE_IN_FOOTER.test(line),
	);
	if (footerAt === -1 || !isAgyBottomAnchored(lines, footerAt)) return null;
	const open = AGY_WRITE_IN_FOOTER.test(lines[footerAt]!);
	const firstOptionAt = lastIndex(lines.slice(0, footerAt), line =>
		/^\s*(?:>\s*)?1\.\s/.test(line),
	);
	if (firstOptionAt === -1) return null;
	const questionEnd = lastIndex(
		lines.slice(0, firstOptionAt),
		line => line.trim() !== '',
	);
	if (questionEnd === -1) return null;
	let questionAt = questionEnd;
	while (
		questionAt > 0 &&
		lines[questionAt - 1]!.trim() !== '' &&
		!RULE.test(lines[questionAt - 1]!)
	) {
		questionAt--;
	}

	const question = lines
		.slice(questionAt, questionEnd + 1)
		.map(line => line.trim())
		.join(' ')
		.replace(/^Question \d+\/\d+:\s*/, '');
	const rows = withCheckboxes(
		readOptions(lines, firstOptionAt, {
			joinWrapped: false,
			optionPattern: AGY_OPTION,
		}),
	);
	const text = rows.find(option => AGY_WRITE_IN.test(option.label));
	const answerRel = lastIndex(lines.slice(firstOptionAt, footerAt), line =>
		AGY_YOUR_ANSWER.test(line),
	);
	const boxText =
		answerRel === -1
			? ''
			: lines
					.slice(firstOptionAt + answerRel + 1, footerAt)
					.map(line => line.trim())
					.filter(Boolean)
					.join(' ');
	const inlineText =
		(text ? AGY_WRITE_IN.exec(text.label)?.[1]?.trim() : undefined) ?? '';
	const typed = [inlineText, boxText].filter(Boolean).join(' ');
	return {
		tabs: [],
		question,
		options: rows.filter(option => option !== text),
		multiSelect: rows.some(option => option.checked !== undefined),
		cursor: rows.find(option => option.selected)?.number ?? null,
		textOption: text
			? {
					number: text.number,
					text: typed,
					open,
					// Agy leaves open Write-in on Escape (`esc Back`); Up stays in the box.
					...(open ? {closeKey: 'Escape' as const} : {}),
				}
			: null,
	};
}

function parseQuestion(lines: string[]): QuestionDialog | null {
	let footerAt = lastIndex(lines, line => QUESTION_FOOTER.test(line));
	if (footerAt === -1 && lines.some(line => TAB_BAR.test(line))) {
		footerAt = lines.length;
	}

	if (footerAt === -1) return parseAgyQuestion(lines);
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
	const rows = withCheckboxes(all.filter(option => option !== chat));
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

const ISO_TIMESTAMP_SOURCE = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})`;
const ISO_TIMESTAMP = new RegExp(`^${ISO_TIMESTAMP_SOURCE}$`);
const INLINE_ISO_TIMESTAMP = new RegExp(
	String.raw`\b(${ISO_TIMESTAMP_SOURCE})\b`,
);
const TRY_AGAIN_AT = /try again at (.*?\d{1,2}:\d{2} ?[AP]M)/i;

/**
 * Codex shows a bare `4:28 AM`, or a date when the reset is days away; agy
 * quota output reports ISO timestamps.
 */
export function parseResetTime(text: string, now: Date): Date | null {
	const trimmed = text.trim();
	if (ISO_TIMESTAMP.test(trimmed)) {
		const parsed = new Date(trimmed);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	const dated =
		/^([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) (\d{1,2}):(\d{2}) ([AP]M)$/i.exec(
			trimmed,
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

	const bare = /^(\d{1,2}):(\d{2}) ([AP]M)$/i.exec(trimmed);
	if (!bare) return null;
	const reset = new Date(now);
	reset.setHours(hours24(bare[1]!, bare[3]!), Number(bare[2]), 0, 0);
	if (now.getTime() - reset.getTime() > BARE_TIME_GRACE_MS) {
		reset.setDate(reset.getDate() + 1);
	}

	return reset;
}

function toUsageLimit(resetText: string, now: Date): UsageLimit {
	const resetAt = resetText ? parseResetTime(resetText, now) : null;
	return {
		resetText,
		resetAt,
		passed: resetAt !== null && now.getTime() >= resetAt.getTime(),
	};
}

/**
 * Parse tab-separated `agy -p /quota` output (`group\twindow\t0%\tISO`),
 * optionally filtered to the space's model family.
 * Returns null when matching buckets still have remaining quota or output is empty.
 */
function agyQuotaMatchesModel(group: string, model?: string): boolean {
	const normalized = model?.trim().toLowerCase() ?? '';
	if (!normalized) return true;
	if (/\bgemini\b/.test(normalized)) {
		return group.toLowerCase().includes('gemini');
	}

	if (/(?:^|[\s/._-])(?:claude|gpt|o\d+)/.test(normalized)) {
		return /\b(?:claude|gpt)\b/i.test(group);
	}

	return true;
}

/** Infer the active agy model name from the screen's bottom status bar. */
export function inferAgyModel(screen: string): string | undefined {
	const tail = screen
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean)
		.slice(-2);
	for (const line of tail) {
		const match = /\b(Gemini\b[^·]*|Claude\b[^·]*|GPT\b[^·]*|o\d+[^·]*)/i.exec(
			line,
		);
		if (match) return match[1]!.trim();
	}

	return undefined;
}

export type AgyQuotaParseResult =
	| {kind: 'limited'; limit: UsageLimit}
	| {kind: 'available'}
	| {kind: 'unparsed'};

export function parseAgyQuotaResult(
	output: string,
	now: Date,
	model?: string,
): AgyQuotaParseResult {
	let matchedRows = 0;
	const depleted: UsageLimit[] = [];
	for (const line of output.split('\n')) {
		const parts = line.split('\t');
		if (parts.length < 4) continue;
		if (!agyQuotaMatchesModel(parts[0]!, model)) continue;
		const percent = parts[2]!.trim();
		if (!/^\d+%$/.test(percent)) continue;
		matchedRows++;
		if (Number(percent.slice(0, -1)) > 0) continue;
		depleted.push(toUsageLimit(parts[3]!.trim(), now));
	}

	if (matchedRows === 0) return {kind: 'unparsed'};
	if (depleted.length === 0) return {kind: 'available'};
	// When both five-hour and weekly buckets are at 0%, wait for the latest reset.
	let best = depleted[0]!;
	for (const row of depleted.slice(1)) {
		if (!row.resetAt) continue;
		if (!best.resetAt || row.resetAt.getTime() > best.resetAt.getTime()) {
			best = row;
		}
	}

	return {kind: 'limited', limit: best};
}

export function parseAgyQuota(
	output: string,
	now: Date,
	model?: string,
): UsageLimit | null {
	const result = parseAgyQuotaResult(output, now, model);
	return result.kind === 'limited' ? result.limit : null;
}

const AGY_LIMIT_NOTICE =
	/^(?:[✕✖■⚠!]\s+|Error:\s+).*?(?:usage limit|quota (?:exceeded|exhausted|reached)|rate limit)/i;
const TRANSCRIPT_BOLD_PROMPT = new RegExp(
	`^\\s*(?:${ESC}\\[0m)?${ESC}\\[1m(?:${ESC}\\[[0-9;]*m)*>`,
);

type ComposerGlyph = '›' | '❯' | '!' | '>';

function looksLikeAgyScreen(
	raw: readonly string[],
	lines: readonly string[],
	input: {at: number; glyph: ComposerGlyph} | null,
	agyDialog: boolean,
): boolean {
	// Another agent's composer rules out agy even if its tool output echoes text.
	if (input && input.glyph !== '>') return false;
	if (input?.glyph === '>' || agyDialog) return true;
	return (
		lines.some(
			line =>
				line.includes('Antigravity CLI') ||
				AGY_STATUS_FOOTER.test(line) ||
				AGY_QUESTION_FOOTER.test(line) ||
				AGY_WRITE_IN_FOOTER.test(line),
		) || raw.some(line => TRANSCRIPT_BOLD_PROMPT.test(line))
	);
}

function parseUsageLimit(
	raw: readonly string[],
	lines: readonly string[],
	now: Date,
	{
		input,
		agyDialog,
	}: {
		input: {at: number; glyph: ComposerGlyph} | null;
		agyDialog: boolean;
	},
): UsageLimit | null {
	// Codex starts the notice at the left edge with its error mark; the same
	// words elsewhere, say in a file an agent prints, aren't a limit.
	const limitAt = lastIndex(
		lines,
		line => line.startsWith('■ ') && line.includes('hit your usage limit'),
	);
	if (limitAt !== -1) {
		// Once the agent works again, an old limit message scrolls up above it.
		if (lastIndex(lines, line => line.startsWith('• ')) > limitAt) return null;
		const joined = lines.slice(limitAt).join(' ').replace(/\s+/g, ' ');
		const resetText = TRY_AGAIN_AT.exec(joined)?.[1] ?? '';
		return toUsageLimit(resetText, now);
	}

	if (!looksLikeAgyScreen(raw, lines, input, agyDialog)) return null;
	const agyAt = lastIndex(lines, line => AGY_LIMIT_NOTICE.test(line));
	if (agyAt === -1) return null;
	const composerTopRule = input?.glyph === '>' ? input.at - 1 : -1;
	const composerBottomRule =
		input?.glyph === '>'
			? lines.findIndex((line, index) => index > input.at && RULE.test(line))
			: -1;
	const stale = lines.slice(agyAt + 1).some((line, offset) => {
		const index = agyAt + 1 + offset;
		return (
			line.startsWith('● ') ||
			line.startsWith('• ') ||
			TRANSCRIPT_BOLD_PROMPT.test(raw[index]!) ||
			(RULE.test(line) &&
				index !== composerTopRule &&
				index !== composerBottomRule)
		);
	});
	if (stale) return null;
	const joined = lines.slice(agyAt).join(' ').replace(/\s+/g, ' ');
	const resetText =
		INLINE_ISO_TIMESTAMP.exec(joined)?.[1] ??
		TRY_AGAIN_AT.exec(joined)?.[1] ??
		'';
	return toUsageLimit(resetText, now);
}

/**
 * The input line: Codex's `›`, Claude's `❯` (`!` in shell mode) between two
 * rules, or agy's `>` between two rules.
 */
function composerLine(
	lines: string[],
	raw: string[],
): {at: number; glyph: ComposerGlyph} | null {
	const codex = lastIndex(lines, line => line.startsWith('› ') || line === '›');
	const claude = lastIndex(
		lines,
		(line, index) =>
			/^[❯!]/.test(line) && INPUT_RULE.test(lines[index - 1] ?? ''),
	);
	const agy = lastIndex(
		lines,
		(line, index) =>
			/^>(?: |$)/.test(line) &&
			RULE.test(lines[index - 1] ?? '') &&
			// Agy echoes submitted prompts in the transcript with bold `> prompt`.
			!TRANSCRIPT_BOLD_PROMPT.test(raw[index] ?? '') &&
			lines.slice(index + 1).some(next => RULE.test(next)),
	);
	const best = Math.max(codex, claude, agy);
	if (best === -1) return null;
	if (codex === best) return {at: codex, glyph: '›'};
	if (claude === best)
		return {at: claude, glyph: lines[claude]!.startsWith('!') ? '!' : '❯'};
	return {at: agy, glyph: '>'};
}

const RESET_SGR_PREFIX = new RegExp(`^(?:${ESC}\\[(?:0|39)m)+`);
const AGY_GREY_SGR = new RegExp(
	`^${ESC}\\[(?:90|38;5;(?:8|23[89]|24\\d|25[01]))m`,
);
const TRUECOLOR_SGR = new RegExp(`^${ESC}\\[38;2;(\\d+);(\\d+);(\\d+)m`);
// Tinted dark terminal themes render muted grey placeholders with slight warm
// or cool RGB channel bias, while < 40 and > 215 are near-black or active text.
const MAX_GREY_CHANNEL_SPREAD = 24;
const MIN_TRUECOLOR_GREY = 40;
const MAX_TRUECOLOR_GREY = 215;

function isPlaceholderStyle(text: string, glyph: ComposerGlyph): boolean {
	if (text.startsWith(`${ESC}[2m`)) return true;
	if (glyph !== '>') return false;
	if (AGY_GREY_SGR.test(text)) return true;
	const rgb = TRUECOLOR_SGR.exec(text);
	if (!rgb) return false;
	const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
	const min = Math.min(...channels);
	const max = Math.max(...channels);
	return (
		min >= MIN_TRUECOLOR_GREY &&
		max <= MAX_TRUECOLOR_GREY &&
		max - min <= MAX_GREY_CHANNEL_SPREAD
	);
}

function parseComposer(raw: string[], lines: string[]): string | null {
	const input = composerLine(lines, raw);
	if (!input) return null;
	const {at, glyph} = input;
	// Claude and Codex draw their placeholder dim (SGR 2); agy draws it grey
	// (SGR 90 in 16-color themes, or 256-color/truecolor grey such as 38;5;246).
	const line = raw[at]!;
	const afterPrompt = line
		.slice(line.indexOf(glyph) + 1)
		.replace(RESET_SGR_PREFIX, '')
		.replace(/^[ \u00A0]/, '');
	if (isPlaceholderStyle(afterPrompt, glyph)) return '';
	const draft = [lines[at]!.slice(lines[at]!.indexOf(glyph) + 1)];
	if (glyph !== '›') {
		// A long Claude or agy draft wraps onto more lines inside the box.
		for (const next of lines.slice(at + 1)) {
			if (RULE.test(next)) break;
			draft.push(next);
		}
	}

	const text = draft
		.map(text => text.trim())
		.filter(Boolean)
		.join('\n');
	return glyph === '!' && text ? `!${text}` : text;
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
	const agyDialog = codexDialog ? false : parseAgyDialog(lines);
	const permission = parsePermission(lines);
	const question = parseQuestion(lines);
	// A dialog takes the keyboard and hides Claude's input box, and its own
	// rows can look like one: a highlighted `❯ 4. Chat about this` under a rule,
	// a `›` message echo left in the transcript, or Codex's highlighted `›`
	// option.
	const composer =
		codexDialog || agyDialog || permission || question
			? null
			: parseComposer(raw, lines);
	// Claude Code shows a suggested next prompt as the placeholder. In plain
	// text it reads as typed, so a supervisor would take it for a draft.
	const input = composer === null ? null : composerLine(lines, raw);
	if (input && composer === '') {
		const line = lines[input.at]!;
		lines[input.at] = line.slice(0, line.indexOf(input.glyph) + 1);
	}

	return {
		spinner: lines.some(
			line => CLAUDE_SPINNER.test(line) || CODEX_SPINNER.test(line),
		),
		permission,
		question,
		usageLimit: parseUsageLimit(raw, lines, now, {input, agyDialog}),
		composer,
		shellMode: input?.glyph === '!',
		agyComposer: input?.glyph === '>',
		codexDialog,
		agyDialog,
		lines,
	};
}
