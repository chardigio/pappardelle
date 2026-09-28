import {spawn, type SpawnOptions} from 'node:child_process';

export function spawnQuietCommand(
	command: string,
	args: string[],
	options: SpawnOptions,
) {
	// Lifecycle output must not reach Ink or keep completion waiting on inherited pipes.
	return spawn(command, args, {...options, stdio: 'ignore'});
}
