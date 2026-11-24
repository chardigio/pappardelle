import {
	inlineConfigErrors,
	readConfig,
	type ConfigLoad,
	type ConfigPaths,
} from './config.ts';
import {createLogger, dismissRecentErrors, getRecentErrors} from './logger.ts';

const log = createLogger('config');

// The TUI reads the config on every selection, and the rail keeps only the
// last few errors, for a few minutes: each line is raised once while it is
// on screen, and raised again if the rail dropped it.
let stateLine: string | undefined;
const linesWhileInvalid = new Set<string>();
let restartNeeded = false;

const OFF_UNTIL_RESTART =
	'Keybindings, watchlists, auto-remove and rail settings are off until Pappardelle restarts';
const RESTART_AFTER_FIX =
	'.pappardelle.yml loads now: restart Pappardelle to turn keybindings, watchlists, auto-remove and rail settings back on';

function raise(message: string): void {
	if (getRecentErrors().some(entry => entry.message === message)) return;
	log.error(message);
}

function dismiss(messages: ReadonlySet<string>): void {
	dismissRecentErrors(entry => messages.has(entry.message));
}

/**
 * The config, with the rail saying whether it is invalid. Fixing or removing
 * the file takes the line down at the next read, along with the lines that
 * only held while it was invalid.
 */
export function readReportedConfig(paths?: ConfigPaths): ConfigLoad {
	const load = readConfig(paths);
	const message =
		load.kind === 'invalid'
			? `.pappardelle.yml is invalid: ${inlineConfigErrors(load.errors)}`
			: undefined;
	if (stateLine !== undefined && stateLine !== message)
		dismiss(new Set([stateLine]));
	stateLine = message;
	if (message) {
		raise(message);
		return load;
	}

	if (linesWhileInvalid.size > 0) {
		dismiss(linesWhileInvalid);
		linesWhileInvalid.clear();
	}

	if (restartNeeded) {
		restartNeeded = false;
		dismiss(new Set([OFF_UNTIL_RESTART]));
		raise(RESTART_AFTER_FIX);
	}

	return load;
}

/**
 * The TUI reads some settings once at startup, so fixing the file doesn't
 * bring them back; the rail says so now and again once the file loads.
 */
export function reportStartedWithInvalidConfig(): void {
	restartNeeded = true;
	raise(OFF_UNTIL_RESTART);
}

/** A line that stops being true once the config loads, such as a held-back session. */
export function reportWhileInvalid(message: string): void {
	linesWhileInvalid.add(message);
	raise(message);
}

/** Something that happened because the config was invalid; it stays true after the fix. */
export function reportConfigEvent(message: string): void {
	raise(message);
}
