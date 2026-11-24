// `pappardelle read <key>`: the last turns of a space's Claude conversation.
// A turn is one prompt the user typed plus the assistant text that answered
// it. Tool results and the text Claude Code injects (isMeta: skill bodies,
// reminders) arrive as user entries too, and are skipped.

import {Buffer} from 'node:buffer';
import {closeSync, fstatSync, openSync, readFileSync, readSync} from 'node:fs';
import {extractAssistantText, findLatestSessionJsonl} from './space-state.ts';

const MAX_TEXT = 500;
const FIRST_TAIL_BYTES = 1024 * 1024;

export interface Turn {
	prompt: string;
	ts?: string;
	replies: string[];
}

function promptText(content: unknown): string | undefined {
	if (typeof content === 'string') return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter(part => part && typeof part === 'object' && part.type === 'text')
		.map(part => (typeof part.text === 'string' ? part.text : ''))
		.join(' ')
		.trim();
	return text || undefined;
}

export function parseTurns(jsonl: string): Turn[] {
	const turns: Turn[] = [];
	for (const line of jsonl.split('\n')) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (!entry || typeof entry !== 'object' || entry.isSidechain) continue;
		if (entry.type === 'user' && !entry.isMeta) {
			const prompt = promptText(entry.message?.content);
			if (prompt)
				turns.push({
					prompt: prompt.slice(0, MAX_TEXT),
					ts: typeof entry.timestamp === 'string' ? entry.timestamp : undefined,
					replies: [],
				});
		} else if (entry.type === 'assistant') {
			const text = extractAssistantText(entry);
			const turn = turns.at(-1);
			if (text && turn) turn.replies.push(text.slice(0, MAX_TEXT));
		}
	}

	return turns;
}

export function readTurns(jsonlPath: string): Turn[] {
	return parseTurns(readFileSync(jsonlPath, 'utf8'));
}

/**
 * The last `count` turns of a transcript, read back from its end. A partner
 * agent's conversation runs for weeks and its transcript can pass 100 MB, so
 * reading all of it for a few turns is too slow. The window doubles until it
 * holds `count` prompts or the whole file. Every turn in a window is whole: a
 * window starts at a line, and replies before its first prompt are dropped.
 * `complete` says whether the whole file was read, so the turn count is exact.
 */
export function readRecentTurns(
	jsonlPath: string,
	count: number,
): {turns: Turn[]; complete: boolean} {
	const fd = openSync(jsonlPath, 'r');
	try {
		const {size} = fstatSync(fd);
		let window = Math.min(size, FIRST_TAIL_BYTES);
		for (;;) {
			const start = size - window;
			const buffer = Buffer.alloc(window);
			readSync(fd, buffer, 0, window, start);
			let text = buffer.toString('utf8');
			// Drop the line the window starts inside of.
			if (start > 0) text = text.slice(text.indexOf('\n') + 1);
			const turns = parseTurns(text);
			if (start === 0 || turns.length >= count)
				return {turns, complete: start === 0};
			window = Math.min(size, window * 2);
		}
	} finally {
		closeSync(fd);
	}
}

function clock(ts: string | undefined): string {
	if (!ts) return '';
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return '';
	const pad = (n: number) => String(n).padStart(2, '0');
	return `[${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}] `;
}

function indent(text: string, prefix: string): string {
	return text
		.split('\n')
		.map((line, index) =>
			index === 0 ? line : ' '.repeat(prefix.length) + line,
		)
		.join('\n');
}

export function formatTurns(
	issueKey: string,
	turns: Turn[],
	count: number,
	complete = true,
): string {
	const recent = turns.slice(-count);
	const lines = [
		complete
			? `${issueKey}: ${turns.length} turns, last ${recent.length}`
			: `${issueKey}: last ${recent.length} turns`,
	];
	for (const turn of recent) {
		const userPrefix = `${clock(turn.ts)}user: `;
		lines.push('', userPrefix + indent(turn.prompt, userPrefix));
		for (const reply of turn.replies) {
			const prefix = '  assistant: ';
			lines.push(prefix + indent(reply, prefix));
		}
	}

	return lines.join('\n');
}

export function turnsJson(
	issueKey: string,
	turns: Turn[],
	count: number,
	complete = true,
) {
	return {
		issueKey,
		...(complete ? {totalTurns: turns.length} : {}),
		turns: turns.slice(-count),
	};
}

export async function runReadCommand(options: {
	issueKey: string;
	/** The transcript of the session the space's status file names, if known. */
	log?: string | null;
	/**
	 * The space's checkout, whose newest transcript is read when `log` isn't
	 * known. Null when it has none, or when other agents share its directory
	 * (the main checkout with partner agents), since the newest transcript
	 * there can be another agent's.
	 */
	worktree: string | null;
	turns: number | undefined;
	json: boolean;
	out: (text: string) => void;
	err: (text: string) => void;
}): Promise<number> {
	const count = options.turns ?? 5;
	if (!Number.isInteger(count) || count < 1) {
		options.err('Usage: pappardelle read <issue-key> [--turns N] [--json]');
		return 1;
	}

	const log =
		options.log ??
		(options.worktree ? await findLatestSessionJsonl(options.worktree) : null);
	if (!log) {
		options.err(`No conversation log for ${options.issueKey}`);
		return 1;
	}

	const {turns, complete} = readRecentTurns(log, count);
	options.out(
		options.json
			? JSON.stringify(
					turnsJson(options.issueKey, turns, count, complete),
					null,
					2,
				)
			: formatTurns(options.issueKey, turns, count, complete),
	);
	return 0;
}
