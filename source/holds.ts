// Prompts space_answer declined for the chef: an agent asked for something
// past a hard stop, or the model check said no. Each hold waits here until the
// chef approves or dismisses it. An approved hold lets space_answer approve
// that same prompt once more, when the agent retries it.

import {randomUUID} from 'node:crypto';
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
	/**
	 * Whether an approval can let the retry through. A Codex edit shows only
	 * its paths, and a cut-off prompt hides its top, so neither is matched.
	 */
	approvable: boolean;
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

const isString = (value: unknown): value is string => typeof value === 'string';
const isOptionalString = (value: unknown): value is string | null =>
	value === null || isString(value);

/** A hold file as `save` leaves it. Throws when `content` is anything else. */
export function parseHold(content: string): Hold {
	const hold = (JSON.parse(content) ?? {}) as Record<string, unknown>;
	const {id, key, tool, command, filePath, cwd, reason, state} = hold;
	const {createdAt, resolvedAt, approvable} = hold;
	if (
		!isString(id) ||
		!isString(key) ||
		!isString(tool) ||
		!isString(command) ||
		!isOptionalString(filePath) ||
		!isOptionalString(cwd) ||
		typeof approvable !== 'boolean' ||
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
		approvable,
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

/** A hold moved on from open, or from approved to used. */
export function resolveHold(
	hold: Hold,
	state: Exclude<HoldState, 'open'>,
	now: Date,
): Hold {
	return {...hold, state, resolvedAt: now.toISOString()};
}

/**
 * The hold for this prompt in the given state: an open one a retry reuses
 * rather than stacking another, or an approved one that lets the prompt
 * through once.
 */
export function holdFor(
	holds: Hold[],
	prompt: HeldPrompt,
	state: 'open' | 'approved',
): Hold | null {
	return (
		holds.find(hold => hold.state === state && isSamePrompt(hold, prompt)) ??
		null
	);
}
