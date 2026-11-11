import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// display-popup -B, -T and -e, which the issue and agent popups pass, arrived
// in tmux 3.3.
export const MIN_TMUX_VERSION = {major: 3, minor: 3};

const execFileAsync = promisify(execFile);

/**
 * Where a version came from. A running server keeps the binary it started
 * with, so after an upgrade `tmux -V` can be newer than the server
 * Pappardelle talks to.
 */
export type TmuxVersion = {version: string; source: 'server' | 'binary'};

async function runTmux(args: string[]): Promise<string | null> {
	try {
		const {stdout} = await execFileAsync('tmux', args, {
			encoding: 'utf-8',
			timeout: 5000,
		});
		const output = stdout.trim();
		return output === '' ? null : output;
	} catch {
		return null;
	}
}

/**
 * The running server's version, which is what Pappardelle's commands run
 * against, or the binary's when no server is running yet.
 */
export async function readTmuxVersion(): Promise<TmuxVersion | null> {
	const server = await runTmux(['display-message', '-p', '#{version}']);
	if (server !== null) return {version: server, source: 'server'};
	const binary = await runTmux(['-V']);
	return binary === null
		? null
		: {version: binary.replace(/^tmux /, ''), source: 'binary'};
}

export type TmuxRelease = {major: number; minor: number; letter?: string};

/** Null for builds without a release number, such as `master`. */
export function parseTmuxVersion(version: string): TmuxRelease | null {
	const match = /(\d+)\.(\d+)([a-z])?/.exec(version);
	if (match === null) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		...(match[3] === undefined ? {} : {letter: match[3]}),
	};
}

/**
 * True only for a release number below the floor. Builds without one are let
 * through rather than blocked on a guess.
 */
export function tmuxVersionTooOld(version: string): boolean {
	const release = parseTmuxVersion(version);
	if (release === null) return false;
	return (
		release.major < MIN_TMUX_VERSION.major ||
		(release.major === MIN_TMUX_VERSION.major &&
			release.minor < MIN_TMUX_VERSION.minor)
	);
}

export function tmuxTooOldMessage({version, source}: TmuxVersion): string[] {
	const floor = `${MIN_TMUX_VERSION.major}.${MIN_TMUX_VERSION.minor}`;
	return [
		source === 'server'
			? `Error: the running tmux server is ${version}; Pappardelle needs tmux ${floor} or newer.`
			: `Error: tmux is ${version}; Pappardelle needs tmux ${floor} or newer.`,
		...(source === 'server'
			? [
					'If `tmux -V` already shows a newer release, restart the tmux server so it runs that binary.',
				]
			: []),
		'See https://github.com/chardigio/pappardelle#tmux-version',
	];
}
