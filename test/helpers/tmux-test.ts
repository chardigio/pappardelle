import {spawnSync} from 'node:child_process';
import {test} from 'bun:test';

export const hasTmux = spawnSync('tmux', ['-V']).status === 0;

/** A test that needs a tmux binary, skipped on a machine without one. */
export const tmuxTest = hasTmux ? test : test.skip;

/** Runs tmux on a private server at `socket`, with `conf` as its config. */
export function tmuxOn(socket: string, conf = '/dev/null') {
	return (...args: string[]) =>
		spawnSync('tmux', ['-S', socket, '-f', conf, ...args], {encoding: 'utf8'});
}
