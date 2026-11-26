import path from 'node:path';
import {TEST_TMUX_GUARD} from './test-run-env.ts';

/**
 * Why the tmux on PATH is not the test tmux guard's wrapper, or undefined when
 * it is or there is no tmux.
 */
function unguardedTmux(): string | undefined {
	const tmux = Bun.which('tmux');
	if (
		tmux === null ||
		tmux === path.join(process.env[TEST_TMUX_GUARD] ?? '', 'bin', 'tmux')
	)
		return undefined;
	return `tmux on PATH is ${tmux}, not the test tmux guard`;
}

/**
 * What would let a tmux this process starts reach a server outside the test
 * tmux guard. TMUX makes a tmux client talk to the server the process was
 * started from, past any socket directory.
 */
export function tmuxGuardProblems(env = process.env): string[] {
	return [
		env['TMUX'] !== undefined && `TMUX is set (${env['TMUX']})`,
		env['TMUX_PANE'] !== undefined && 'TMUX_PANE is set',
		unguardedTmux(),
	].filter(problem => typeof problem === 'string');
}

/**
 * Stops a suite outside the unit tests that starts real tmux from running
 * without the test tmux guard. A test that reached the inner server once ended
 * every agent session the user had open.
 */
export function requireTmuxGuard(): void {
	const problems = tmuxGuardProblems();
	if (problems.length > 0)
		throw new Error(
			`${problems.join('; ')}. Run this check through test/helpers/tmux-guard-run.sh.`,
		);
}
