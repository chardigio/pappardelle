// Prompts space_answer declined for the chef: an agent asked for something
// past a hard stop, or the model check said no. Each hold waits here until the
// chef approves or dismisses it. An approved hold lets space_answer approve
// that same prompt once more, when the agent retries it. Holds live in
// ~/.pappardelle/repos/{repo}/holds/, one file each.

import {randomUUID} from 'node:crypto';
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const HOLD_STATES = ['open', 'approved', 'dismissed', 'used'] as const;
export type HoldState = (typeof HOLD_STATES)[number];

/** What identifies a prompt: the same call from the same space. */
export type HeldPrompt = {
	key: string;
	tool: string;
	command: string;
	/** The file an Edit, Write or Read prompt is for. */
	filePath: string | null;
	cwd: string | null;
};

export type Hold = HeldPrompt & {
	id: string;
	reason: string;
	state: HoldState;
	createdAt: string;
	/** When the chef approved or dismissed it, or it was used. */
	resolvedAt: string | null;
};

export interface HoldDao {
	save(hold: Hold): Promise<void>;
	load(id: string): Hold | null;
	list(): Hold[];
}

export function holdsDir(repoName: string, baseDir: string): string {
	return path.join(baseDir, 'repos', repoName, 'holds');
}

export function newHoldId(): string {
	return `h${randomUUID().slice(0, 7)}`;
}

export function renderHold(hold: Hold): string {
	return JSON.stringify(hold, null, '\t') + '\n';
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isOptionalString = (value: unknown): value is string | null =>
	value === null || isString(value);

/** A hold file as `save` leaves it. Throws when `content` is anything else. */
export function parseHold(content: string): Hold {
	const hold = (JSON.parse(content) ?? {}) as Record<string, unknown>;
	const {id, key, tool, command, filePath, cwd, reason, state} = hold;
	const {createdAt, resolvedAt} = hold;
	if (
		!isString(id) ||
		!isString(key) ||
		!isString(tool) ||
		!isString(command) ||
		!isOptionalString(filePath) ||
		!isOptionalString(cwd) ||
		!isString(reason) ||
		!HOLD_STATES.includes(state as HoldState) ||
		!isString(createdAt) ||
		!isOptionalString(resolvedAt)
	)
		throw new Error('Not a hold');
	return {
		id,
		key,
		tool,
		command,
		filePath,
		cwd,
		reason,
		state: state as HoldState,
		createdAt,
		resolvedAt,
	};
}

/**
 * Whether a hold is for this prompt. The command is compared as the screen
 * shows it, so the same call wrapped at another pane width doesn't match,
 * and holds again.
 */
export function isSamePrompt(hold: HeldPrompt, prompt: HeldPrompt): boolean {
	return (
		hold.key === prompt.key &&
		hold.tool === prompt.tool &&
		hold.command === prompt.command &&
		hold.filePath === prompt.filePath &&
		hold.cwd === prompt.cwd
	);
}

/** The open hold for this prompt, which a retry reuses rather than stacking another. */
export function openHoldFor(holds: Hold[], prompt: HeldPrompt): Hold | null {
	return (
		holds.find(hold => hold.state === 'open' && isSamePrompt(hold, prompt)) ??
		null
	);
}

/** The approved hold, not yet used, that lets this prompt through once. */
export function approvedHoldFor(
	holds: Hold[],
	prompt: HeldPrompt,
): Hold | null {
	return (
		holds.find(
			hold => hold.state === 'approved' && isSamePrompt(hold, prompt),
		) ?? null
	);
}

export class JsonHoldDao implements HoldDao {
	constructor(private readonly dir: string) {}

	holdFile(id: string): string {
		return path.join(this.dir, `${id}.json`);
	}

	/** The ids of the hold files on disk. */
	ids(): string[] {
		let files: string[];
		try {
			files = readdirSync(this.dir);
		} catch {
			return [];
		}

		return files
			.filter(file => file.endsWith('.json'))
			.map(file => file.slice(0, -5));
	}

	async save(hold: Hold): Promise<void> {
		mkdirSync(this.dir, {recursive: true});
		const file = this.holdFile(hold.id);
		writeFileSync(`${file}.tmp`, renderHold(hold));
		renameSync(`${file}.tmp`, file);
	}

	load(id: string): Hold | null {
		try {
			return parseHold(readFileSync(this.holdFile(id), 'utf8'));
		} catch {
			return null;
		}
	}

	list(): Hold[] {
		return this.ids()
			.map(id => this.load(id))
			.filter((hold): hold is Hold => hold !== null)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
}
