// `pappardelle read <key>`: the last turns of a space's conversation.
// A turn is one prompt the user typed plus the assistant text that answered
// it. Tool results and injected metadata/system entries are skipped.

import {readFileSync} from 'node:fs';
import type {PappardelleConfig} from './config.ts';
import {
	extractAgyUserText,
	extractAssistantText,
	findSpaceTranscript,
	type AgentSessionsDao,
	type SpaceStateDao,
	type TranscriptFormat,
} from './space-state.ts';

const MAX_TEXT = 500;

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

export function parseAgyTurns(jsonl: string): Turn[] {
	const turns: Turn[] = [];
	for (const line of jsonl.split('\n')) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (!entry || typeof entry !== 'object') continue;
		if (entry.type === 'USER_INPUT') {
			const prompt = extractAgyUserText(entry.content);
			if (prompt) {
				turns.push({
					prompt: prompt.slice(0, MAX_TEXT),
					ts:
						typeof entry.created_at === 'string' ? entry.created_at : undefined,
					replies: [],
				});
			}
		} else if (entry.type === 'PLANNER_RESPONSE') {
			const text =
				typeof entry.content === 'string' ? entry.content.trim() : '';
			const turn = turns.at(-1);
			if (text && turn) turn.replies.push(text.slice(0, MAX_TEXT));
		}
	}

	return turns;
}

export function parseTurns(
	jsonl: string,
	format: TranscriptFormat = 'claude',
): Turn[] {
	if (format === 'agy') return parseAgyTurns(jsonl);
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

export function readTurns(
	jsonlPath: string,
	format: TranscriptFormat = 'claude',
): Turn[] {
	return parseTurns(readFileSync(jsonlPath, 'utf8'), format);
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
): string {
	const recent = turns.slice(-count);
	const lines = [`${issueKey}: ${turns.length} turns, last ${recent.length}`];
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

export function turnsJson(issueKey: string, turns: Turn[], count: number) {
	return {issueKey, totalTurns: turns.length, turns: turns.slice(-count)};
}

export async function runReadCommand(options: {
	issueKey: string;
	/** The space's checkout, or null when it has none. */
	worktree: string | null;
	spaceState?: Pick<SpaceStateDao, 'read'>;
	agentSessions?: Pick<AgentSessionsDao, 'read'>;
	config?: PappardelleConfig | null;
	home?: string;
	claudeProjectsDir?: string;
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

	const transcript = await findSpaceTranscript({
		issueKey: options.issueKey,
		worktreePath: options.worktree,
		spaceState: options.spaceState,
		agentSessions: options.agentSessions,
		config: options.config,
		home: options.home,
		claudeProjectsDir: options.claudeProjectsDir,
	});
	if (!transcript) {
		options.err(`No conversation log for ${options.issueKey}`);
		return 1;
	}

	const turns = readTurns(transcript.file, transcript.format);
	options.out(
		options.json
			? JSON.stringify(turnsJson(options.issueKey, turns, count), null, 2)
			: formatTurns(options.issueKey, turns, count),
	);
	return 0;
}
