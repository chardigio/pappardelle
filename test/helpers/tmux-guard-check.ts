import path from 'node:path';
import {TEST_TMUX_GUARD} from './test-run-env.ts';

/**
 * Why the tmux on PATH is not the test tmux guard's wrapper, or undefined when
 * it is or there is no tmux.
 */
export function unguardedTmux(): string | undefined {
	const tmux = Bun.which('tmux');
	if (
		tmux === null ||
		tmux === path.join(process.env[TEST_TMUX_GUARD] ?? '', 'bin', 'tmux')
	)
		return undefined;
	return `tmux on PATH is ${tmux}, not the test tmux guard`;
}

/**
 * Stops a suite outside the unit tests that starts real tmux from running
 * without the test tmux guard. A test that reached the inner server once ended
 * every agent session the user had open.
 */
export function requireTmuxGuard(): void {
	const problem = unguardedTmux();
	if (problem)
		throw new Error(
			`${problem}. Run this check through test/helpers/tmux-guard-run.sh.`,
		);
}
