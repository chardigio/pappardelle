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
	 * How an option is chosen: Claude and agy prompts take their digit, Codex
	 * and agy subagent banners use the option's shortcut key. A digit on Codex
	 * only moves the highlight.
	 */
	choose: 'digit' | 'shortcut';
	/** Set for agy prompts, which carry no Claude hook state. */
	source?: 'agy';
	/** Single absolute file path read directly from an agy file prompt. */
	filePath?: string;
	/** Inline agy subagent approval banner drawn above the live composer. */
	subagentBanner?: {vimInsert: boolean};
	/** The files a Codex patch would change, as absolute paths. */
	files?: string[];
	/**
	 * The prompt is taller than the agent's screen and its top is cut off (or
	 * agy hid lines inside the command block): the full call cannot be read.
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

export type AgyDialogKind =
	| 'trust'
	| 'artifact_review'
	| 'subagent_manage'
	| 'config'
	| 'model_picker';

/**
 * Agy keeps OSC blocked/permission "Approve plan" while showing its open
 * composer under `N artifact · /artifact to review`; that is not a modal prompt.
 */
export function isAgyArtifactBanner(
	status: {status?: string; message?: string} | null | undefined,
	screen: Pick<AgentScreen, 'agyComposer'>,
): boolean {
	return (
		status?.status === 'blocked' &&
		status.message === 'Approve plan' &&
		Boolean(screen.agyComposer?.artifactReview)
	);
}

export type AgyComposerState = {
	/** Agy's vim composer is currently in INSERT mode (`-- INSERT --` in footer). */
	vimInsert: boolean;
	/** Agy's dismissible announcement banner (`┃ esc to dismiss`) sits above the composer. */
	announcementBanner: boolean;
	/** Agy is mid-turn (braille spinner or `esc to cancel` in the footer). */
	working: boolean;
	/**
	 * Agy shows `<N> artifact · /artifact to review` above an open composer with
	 * no modal prompt on screen; OSC still emits blocked/permission "Approve plan".
	 */
	artifactReview: boolean;
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
	/** Agy's `>` input box state (null when not showing an agy composer). */
	agyComposer: AgyComposerState | null;
	/** Codex's own dialogs (folder trust, model switch) that take the keyboard. */
	codexDialog: CodexDialog | null;
	/** Agy modal dialogs (folder trust, artifact review, subagent manage) that take the keyboard. */
	agyDialog: AgyDialogKind | null;
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
// After an approval inside subagent manage is answered, agy stays on the
// subagent trajectory screen with this footer until Escape returns to main.
const AGY_SUBAGENT_DETAIL_FOOTER =
	/^\s*↑\/↓ scroll · pgup\/pgdown page\b.*\besc back\s*$/;
const AGY_TRUST_FOOTER = /^\s*↑\/↓ Navigate · enter Confirm\s*$/;
const AGY_TRUST_PROMPT = /^\s*Do you trust the contents of this project\?\s*$/;
const AGY_ARTIFACT_REVIEW_FOOTER =
	/^\s*Keyboard:\s+↑\/↓ Navigate\b.*(?:\by\/n Approve\/reject\b|\bp [Pp]review\b).*\besc (?:Done|Dismiss)\s*$/;
const AGY_CONFIG_FOOTER =
	/^\s*Keyboard:\s+↑\/↓ Navigate\b.*\s←\/→ Change\b.*\besc Clear Search\/Exit\s*$/;
const AGY_MODEL_PICKER_FOOTER =
	/^\s*Keyboard:\s+↑\/↓ Navigate\b.*\s←\/→ Effort\b.*\besc Go Back\s*$/;
const AGY_CONFIG_SUBMENU_FOOTER =
	/^\s*Keyboard:\s+↑\/↓ Navigate\b.*\benter (?:Select|Save)\b.*\besc (?:Go Back|Cancel)\s*$/;
// Agy permission footers start with `↑/↓ Navigate` and omit `enter` (unlike
// questions `enter Select` and trust `enter Confirm`).
const AGY_PERMISSION_FOOTER = /^\s*↑\/↓ Navigate(?:\s+·\s+(?!enter\b).*)?\s*$/;
const AGY_HIDDEN_LINES = /^\s*⋯\s*\(\d+\s+lines?\s+hidden\)\s*$/;
const AGY_DIFF_LINE = /^\s*(?:\d+\s+[+-]?|@@|[+-]{3}\s|$)/;
const AGY_TRUNCATED_ARGS = /(?:\.{3}|…)\)?$/;
const AGY_ARTIFACT_REVIEW_BANNER =
	/\b\d+\s+artifacts?(?:\(s\))?\s+·\s+\/artifact to review\s*$/;
const AGY_SUBAGENT_APPROVAL_BANNER = /^\s*┃\s+ctrl\+k approve\b/;
const AGY_SUBAGENT_HEADER = /^(.+?)\s+needs approval for\s+(.+?)\s*$/;
const AGY_SUBAGENT_TOOL_NAMES: Record<string, string> = {
	Bash: 'Bash command',
	RunCommand: 'Bash command',
	Create: 'Create file',
	Write: 'Create file',
	WriteFile: 'Create file',
	Edit: 'Edit file',
	EditFile: 'Edit file',
	Update: 'Edit file',
	Read: 'Read file',
	ReadFile: 'Read file',
};
const AGY_FILE_HEADERS = new Set([
	'Create file',
	'Edit file',
	'Update file',
	'Write file',
	'Overwrite file',
]);
const AGY_PERMISSION_HEADERS = new Set([
	'Command',
	...AGY_FILE_HEADERS,
	'File access',
	'MCP',
]);
const AGY_ANNOUNCEMENT_DISMISS = /^\s*┃\s+esc to dismiss\s*$/;
const AGY_VIM_INSERT = /^\s*--\s+INSERT\s+--(?:\s|$)/;
const AGY_ESC_TO_CANCEL =
	/^\s*(?:--\s+INSERT\s+--\s+)?esc\s+to\s+cancel(?:\s{2,}|$)/;
const AGY_BRAILLE_SPINNER = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]\s+\S/;
// Lowercase `esc to cancel` followed by spaces/EOL matches agy's footer, not
// Claude's `Esc to cancel · Tab to amend`; model lines require agy's effort
// suffix or `auto ·` prefix rather than Codex's `<model> · <path>`.
const AGY_STATUS_FOOTER =
	/^\s*(?:--\s+INSERT\s+--\s+)?(?:(?:\?\s+for\s+shortcuts|esc\s+to\s+cancel)\s+)?(?:(?:auto|plan|manual|default|accept[- ]edits)\s+·\s+)?(?:Gemini|Claude|GPT)\b.*·\s*(?:minimal|low|medium|high|xhigh|max)\b(?:\s+·\s+\d+\s+(?:subagent|task)\(s\)(?:\s+·\s+\/tasks)?)?\s*$/;
const AGY_BOTTOM_LINE = new RegExp(
	`${AGY_ESC_TO_CANCEL.source}|${AGY_STATUS_FOOTER.source}`,
);
const AGY_OPTION = /^\s*(>\s*)?(\d+)\.\s+(.+?)\s*$/;
const AGY_WRITE_IN = /^Write-in(?:\.\.\.|:\s*(.+))$/;
const TYPE_SOMETHING = /^Type something\.?$/;
const CHECKBOX = /^\[([ ✔])\]\s*/;
// A bare reset time up to this far in the past is today's and has passed: a
// limit that reset at 4:28 AM, read at 5:00 AM, isn't tomorrow's.
const BARE_TIME_GRACE_MS = 6 * 60 * 60 * 1000;

const APPROVE_ONCE_LABELS = new Set([
	'Yes',
	'Yes, proceed',
	'Yes, run command',
	'Yes, allow creation',
	'Yes, allow edit',
	'Yes, allow update',
	'Yes, allow access',
	'Yes, allow tool call',
	'Yes, approve',
]);

function optionKind(label: string): OptionKind {
	if (APPROVE_ONCE_LABELS.has(label)) return 'approve_once';
	// "Yes, and don't ask again …", "Yes, and switch to auto mode" and
	// "Yes, and always allow …" widen what the agent may do beyond this call.
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

function trimBlankLines(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && !lines[start]!.trim()) start++;
	while (end > start && !lines[end - 1]!.trim()) end--;
	return lines.slice(start, end);
}

/**
 * Scan backwards above an agy `MCP` permission header for the `● server/tool(args)`
 * transcript call line in the current turn so the approval gate and classifier
 * see the arguments too.
 */
function findAgyMcpCallLine(
	lines: readonly string[],
	before: number,
	mcpName: string,
): string {
	for (let index = before - 1; index >= 0; index--) {
		const rawLine = lines[index]!;
		const trimmed = rawLine.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith('● ')) {
			const stripped = trimmed
				.slice(2)
				.replace(/\s+\(ctrl\+o to expand\)\s*$/, '')
				.trim();
			if (
				!mcpName ||
				stripped.startsWith(`${mcpName}(`) ||
				stripped === mcpName
			) {
				return stripped;
			}

			return '';
		}

		// Stop at a turn separator rule or user prompt so an earlier turn's call
		// to the same MCP tool is never attributed to this prompt.
		if (RULE.test(trimmed) || /^>\s+\S/.test(rawLine)) return '';
	}

	return '';
}

function anchoredFooterAt(
	lines: readonly string[],
	match: (line: string) => boolean,
): number {
	const at = lastIndex(lines, match);
	return at !== -1 && isAgyBottomAnchored(lines, at) ? at : -1;
}

/**
 * Parse the approval choices shown inside agy's `subagent_manage` view so
 * denying can move to the actual `No, deny` row instead of pressing blindly.
 */
export function parseAgySubagentManageApproval(
	screen: string,
): {cursor: number; denyNumber: number} | null {
	const lines = stripVTControlCharacters(screen).split('\n');
	const markerAt = lastIndex(lines, line =>
		/^\s*⚠\s+Approval Required\s*$/.test(line),
	);
	if (markerAt === -1) return null;
	const endRel = lines
		.slice(markerAt + 1)
		.findIndex(line => RULE.test(line) || AGY_MANAGE_FOOTER.test(line));
	const section = lines.slice(
		markerAt + 1,
		endRel === -1 ? undefined : markerAt + 1 + endRel,
	);
	const firstOption = section.findIndex(line =>
		/^\s*(?:>\s*)?1\.\s/.test(line),
	);
	if (firstOption === -1) return null;
	const options = readOptions(section, firstOption, {
		joinWrapped: true,
		optionPattern: AGY_OPTION,
	});
	const selected = options.find(option => option.selected);
	const deny = options.find(option => option.kind === 'deny');
	if (!selected || !deny) return null;
	return {cursor: selected.number, denyNumber: deny.number};
}

function parseAgyPermission(lines: string[]): PermissionPrompt | null {
	const footerAt = anchoredFooterAt(lines, line =>
		AGY_PERMISSION_FOOTER.test(line),
	);
	if (footerAt === -1) return null;
	const firstOptionAt = lastIndex(lines.slice(0, footerAt), line =>
		/^\s*(?:>\s*)?1\.\s/.test(line),
	);
	if (firstOptionAt === -1) return null;
	const options = readOptions(lines.slice(0, footerAt), firstOptionAt, {
		joinWrapped: true,
		optionPattern: AGY_OPTION,
	});
	if (options.length === 0) return null;
	const questionAt = lastIndex(
		lines.slice(0, firstOptionAt),
		line => line.trim() !== '',
	);
	if (questionAt === -1) return null;
	const question = lines[questionAt]!.trim();
	if (!question.endsWith('?')) return null;

	// Scan for a rule preceded by a recognized agy permission header so a `────`
	// line inside a shell command or diff cannot shift the header into the body.
	let ruleAt = -1;
	let headerAt = -1;
	for (let index = questionAt - 1; index >= 1; index--) {
		if (!RULE.test(lines[index]!)) continue;
		const candidateAt = lastIndex(
			lines.slice(0, index),
			line => line.trim() !== '',
		);
		if (
			candidateAt !== -1 &&
			AGY_PERMISSION_HEADERS.has(lines[candidateAt]!.trim())
		) {
			ruleAt = index;
			headerAt = candidateAt;
			break;
		}
	}

	if (ruleAt === -1 || headerAt === -1) return null;
	const header = lines[headerAt]!.trim();
	const body = trimBlankLines(lines.slice(ruleAt + 1, questionAt));
	const base = {
		subagent: null,
		question,
		options,
		choose: 'digit' as const,
		source: 'agy' as const,
	};

	if (header === 'Command') {
		const reqAt = body.findIndex(line =>
			/^\s*Requesting permission for:\s*$/.test(line),
		);
		const commandLines = trimBlankLines(
			reqAt === -1 ? body : body.slice(reqAt + 1),
		).map(line => line.replace(/^ {1,3}/, '').trimEnd());
		return {
			...base,
			tool: 'Bash command',
			description: '',
			command: commandLines.join('\n'),
			cutOff: commandLines.some(line => AGY_HIDDEN_LINES.test(line)),
		};
	}

	if (AGY_FILE_HEADERS.has(header)) {
		const firstLine = body[0]?.trim() ?? '';
		const pathCandidate = firstLine
			.replace(/\s+(?:[+-]\d+(?:\s+[+-]\d+)*)$/, '')
			.trim();
		// If line 2 does not look like a diff/hunk line, the path may have wrapped.
		const unwrappedPath = body.length <= 1 || AGY_DIFF_LINE.test(body[1]!);
		const filePath =
			unwrappedPath && pathCandidate.startsWith('/')
				? pathCandidate
				: undefined;
		const diff = trimBlankLines(body.slice(1))
			.map(line => line.trimEnd())
			.join('\n');
		return {
			...base,
			tool: header === 'Update file' ? 'Edit file' : header,
			description: filePath ?? firstLine,
			command: diff,
			...(filePath ? {filePath} : {}),
			cutOff: false,
		};
	}

	if (header === 'File access') {
		const detail = body.map(line => line.trim()).join('\n');
		const firstLine = body[0]?.trim() ?? '';
		const singleLine = body.length === 1;
		const readMatch = /^Read:\s+(.+)$/.exec(firstLine);
		if (readMatch) {
			const rawPath = readMatch[1]!.trim();
			const filePath =
				singleLine && rawPath.startsWith('/') ? rawPath : undefined;
			return {
				...base,
				tool: 'Read file',
				description: rawPath,
				command: detail,
				...(filePath ? {filePath} : {}),
				cutOff: false,
			};
		}

		// Non-`Read:` file access stays `File access` so `{reading: true}` is never granted.
		const otherPath = singleLine
			? /^[A-Za-z][A-Za-z0-9 _-]*:\s+(\/\S.*)$/.exec(firstLine)?.[1]?.trim()
			: undefined;
		return {
			...base,
			tool: 'File access',
			description: firstLine,
			command: detail,
			...(otherPath ? {filePath: otherPath} : {}),
			cutOff: false,
		};
	}

	const mcpName = body[0]?.trim() ?? '';
	const callLine = findAgyMcpCallLine(lines, headerAt, mcpName);
	const command = callLine || body.map(line => line.trim()).join('\n');
	return {
		...base,
		tool: 'MCP',
		description: mcpName,
		command,
		cutOff: Boolean(callLine && AGY_TRUNCATED_ARGS.test(callLine)),
	};
}

/**
 * Agy draws subagent approval requests as an inline `┃` banner above its live
 * composer while the subagent pauses (`ctrl+k approve · alt+j manage`).
 */
function parseAgySubagentBanner(
	lines: string[],
	raw: string[],
): PermissionPrompt | null {
	const input = composerLine(lines, raw);
	if (input?.glyph !== '>') return null;
	const topRule = input.at - 1;
	const actionAt = lastIndex(
		lines.slice(0, topRule),
		line => line.trim() !== '',
	);
	if (actionAt === -1 || !AGY_SUBAGENT_APPROVAL_BANNER.test(lines[actionAt]!))
		return null;
	let start = actionAt;
	while (start > 0 && /^\s*┃/.test(lines[start - 1]!)) start--;
	const stripped = lines
		.slice(start, actionAt)
		.map(line => line.replace(/^\s*┃ ?/, '').trimEnd());
	const headerLine = stripped.find(line => line.trim() !== '')?.trim() ?? '';
	const headerMatch = AGY_SUBAGENT_HEADER.exec(headerLine);
	if (!headerMatch) return null;
	const subagent = headerMatch[1]!.trim();
	const rawTool = headerMatch[2]!.trim();

	const callStart = stripped.findIndex(line =>
		line.trimStart().startsWith('● '),
	);
	if (callStart === -1) return null;
	const callLines = trimBlankLines(stripped.slice(callStart));
	let cutOff = callLines.some(line => AGY_HIDDEN_LINES.test(line));
	const joinedCall = callLines
		.map((line, index) =>
			(index === 0 ? line.trimStart() : line.replace(/^ {1,2}/, '')).trimEnd(),
		)
		.join('\n');
	const afterBullet = joinedCall.replace(/^●\s+/, '');
	const openMatch = /^([^(]+)\(([\s\S]*)$/.exec(afterBullet);
	let args: string;
	if (!openMatch) {
		args = afterBullet;
		if (AGY_TRUNCATED_ARGS.test(afterBullet)) cutOff = true;
	} else if (afterBullet.endsWith(')')) {
		args = openMatch[2]!.slice(0, -1).trim();
		if (AGY_TRUNCATED_ARGS.test(args)) cutOff = true;
	} else {
		args = openMatch[2]!.trim();
		cutOff = true;
	}

	const tool = AGY_SUBAGENT_TOOL_NAMES[rawTool] ?? rawTool;
	const filePath =
		(tool === 'Create file' || tool === 'Edit file' || tool === 'Read file') &&
		!args.includes('\n') &&
		!cutOff &&
		args.startsWith('/')
			? args
			: undefined;

	const bottomRule = findBottomRule(lines, input.at);
	const footerLines = bottomRule === -1 ? [] : lines.slice(bottomRule + 1);
	const vimInsert = footerLines.some(line => AGY_VIM_INSERT.test(line));

	return {
		tool,
		subagent,
		description: '',
		command: args,
		question: headerLine,
		options: [
			{
				number: 1,
				label: 'Yes, approve',
				kind: 'approve_once',
				selected: true,
				shortcut: 'C-k',
			},
			{
				number: 2,
				label: 'No, deny',
				kind: 'deny',
				selected: false,
				shortcut: 'M-j',
			},
		],
		choose: 'shortcut',
		source: 'agy',
		...(filePath ? {filePath} : {}),
		subagentBanner: {vimInsert},
		cutOff,
	};
}

function parsePermission(
	lines: string[],
	raw: string[],
): PermissionPrompt | null {
	const codex = parseCodexApproval(lines);
	if (codex) return codex;
	const agy = parseAgyPermission(lines);
	if (agy) return agy;
	const agySubagent = parseAgySubagentBanner(lines, raw);
	if (agySubagent) return agySubagent;
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

const AGY_OVERLAY_LOOKBACK = 45;

function agyOverlayHeaderAbove(
	lines: readonly string[],
	footerAt: number,
): 'config' | 'model_picker' | null {
	const floor = Math.max(0, footerAt - AGY_OVERLAY_LOOKBACK);
	for (let index = footerAt - 1; index >= floor; index--) {
		const line = lines[index]!;
		// Stop at the composer line above the overlay so scrollback text can't match.
		if (/^>(?: |$)/.test(line)) break;
		if (/^\s*Settings\s*$/.test(line)) return 'config';
		if (/^\s*Switch Model\s*$/.test(line)) return 'model_picker';
	}

	return null;
}

const AGY_DIALOG_SPECS: ReadonlyArray<{
	kind: AgyDialogKind;
	footer: RegExp;
	requireAbove?: RegExp;
}> = [
	{kind: 'subagent_manage', footer: AGY_MANAGE_FOOTER},
	{kind: 'subagent_manage', footer: AGY_SUBAGENT_DETAIL_FOOTER},
	{kind: 'trust', footer: AGY_TRUST_FOOTER, requireAbove: AGY_TRUST_PROMPT},
	{kind: 'artifact_review', footer: AGY_ARTIFACT_REVIEW_FOOTER},
	{kind: 'model_picker', footer: AGY_MODEL_PICKER_FOOTER},
	{kind: 'config', footer: AGY_CONFIG_FOOTER},
];

function parseAgyDialogKind(lines: string[]): AgyDialogKind | null {
	for (const {kind, footer, requireAbove} of AGY_DIALOG_SPECS) {
		const footerAt = anchoredFooterAt(lines, line => footer.test(line));
		if (
			footerAt !== -1 &&
			(!requireAbove ||
				lines.slice(0, footerAt).some(line => requireAbove.test(line)))
		) {
			return kind;
		}
	}

	const submenuAt = anchoredFooterAt(lines, line =>
		AGY_CONFIG_SUBMENU_FOOTER.test(line),
	);
	if (submenuAt !== -1) return agyOverlayHeaderAbove(lines, submenuAt);
	return null;
}

function questionBlock(
	lines: readonly string[],
	before: number,
	edge: (line: string) => boolean,
): {at: number; lines: string[]} | null {
	const end = lastIndex(lines.slice(0, before), line => line.trim() !== '');
	if (end === -1) return null;
	let at = end;
	while (at > 0 && !edge(lines[at - 1]!)) at--;
	return {at, lines: lines.slice(at, end + 1)};
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
	const block = questionBlock(
		lines,
		firstOptionAt,
		line => line.trim() === '' || RULE.test(line),
	);
	if (!block) return null;
	const question = block.lines
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
	const block = questionBlock(
		lines,
		firstOptionAt,
		line => line.trim() === '' || RULE.test(line) || TAB_BAR.test(line),
	);
	const questionAt = block?.at ?? 0;
	const question = (block?.lines ?? [])
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

export function parseAgyQuota(
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
	agyDialog: AgyDialogKind | null,
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

function findBottomRule(lines: readonly string[], after: number): number {
	return lines.findIndex((line, index) => index > after && RULE.test(line));
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
		agyDialog: AgyDialogKind | null;
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
		input?.glyph === '>' ? findBottomRule(lines, input.at) : -1;
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
	// Agy overlays drawn under its composer (such as /artifact rows) use `› `
	// selection markers; ignore Codex's `›` branch on an agy screen.
	const effectiveCodex =
		agy !== -1 &&
		codex > agy &&
		lines
			.slice(agy + 1)
			.some(
				line => AGY_STATUS_FOOTER.test(line) || /^\s*Keyboard:\s+/.test(line),
			)
			? -1
			: codex;
	const best = Math.max(effectiveCodex, claude, agy);
	if (best === -1) return null;
	if (effectiveCodex === best) return {at: effectiveCodex, glyph: '›'};
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

function parseComposer(
	raw: string[],
	lines: string[],
	input: {at: number; glyph: ComposerGlyph},
): string {
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

// Bounded lookbacks above the agy composer's top rule keep live strips and
// banners distinct from older scrollback without missing wrapped lines.
const AGY_SPINNER_LOOKBACK = 3; // spinner + optional tip line
const AGY_BANNER_LOOKBACK = 5; // announcement box or artifact review strip
const AGY_SUBAGENT_BANNER_LOOKBACK = 9; // multi-line subagent approval banner

function linesAbove(
	lines: readonly string[],
	topRule: number,
	count: number,
): readonly string[] {
	const end = Math.max(0, topRule);
	return lines.slice(Math.max(0, end - count), end);
}

function parseAgyComposer(
	lines: readonly string[],
	input: {at: number; glyph: ComposerGlyph} | null,
): AgyComposerState | null {
	if (input?.glyph !== '>') return null;
	const topRule = input.at - 1;
	const bottomRule = findBottomRule(lines, input.at);
	const footerLines = bottomRule === -1 ? [] : lines.slice(bottomRule + 1);
	const bannerZone = linesAbove(lines, topRule, AGY_BANNER_LOOKBACK);
	return {
		vimInsert: footerLines.some(line => AGY_VIM_INSERT.test(line)),
		announcementBanner: bannerZone.some(line =>
			AGY_ANNOUNCEMENT_DISMISS.test(line),
		),
		working:
			footerLines.some(line => AGY_ESC_TO_CANCEL.test(line)) ||
			linesAbove(lines, topRule, AGY_SPINNER_LOOKBACK).some(line =>
				AGY_BRAILLE_SPINNER.test(line),
			),
		artifactReview:
			bannerZone.some(line => AGY_ARTIFACT_REVIEW_BANNER.test(line)) &&
			!linesAbove(lines, topRule, AGY_SUBAGENT_BANNER_LOOKBACK).some(line =>
				AGY_SUBAGENT_APPROVAL_BANNER.test(line),
			),
	};
}

export function parseAgentScreen(capture: string, now: Date): AgentScreen {
	const raw = capture.replace(/\n+$/, '').split('\n');
	const lines = raw.map(line => stripVTControlCharacters(line));
	const codexDialog = parseCodexDialog(raw, lines);
	const agyDialog = codexDialog ? null : parseAgyDialogKind(lines);
	const permission =
		codexDialog || agyDialog ? null : parsePermission(lines, raw);
	const question = parseQuestion(lines);
	// A dialog takes the keyboard and hides Claude's input box, and its own
	// rows can look like one: a highlighted `❯ 4. Chat about this` under a rule,
	// a `›` message echo left in the transcript, or Codex's highlighted `›`
	// option.
	const input =
		codexDialog || agyDialog || permission || question
			? null
			: composerLine(lines, raw);
	const composer = input ? parseComposer(raw, lines, input) : null;
	// Claude Code shows a suggested next prompt as the placeholder. In plain
	// text it reads as typed, so a supervisor would take it for a draft.
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
		agyComposer: parseAgyComposer(lines, input),
		codexDialog,
		agyDialog,
		lines,
	};
}
