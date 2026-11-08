import {mkdir, readFile, stat, unlink, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {processIsAlive} from './tui-marker.ts';

export class SendLockTimeout extends Error {}

// A send is several tmux calls (clear, paste, Enter). Sous-chef relays,
// timers and the rail can send to one agent at the same time from separate
// processes, and without this their pastes and Enters interleave.
export async function withSendLock<T>(
	session: string,
	task: () => Promise<T>,
	options: {
		dir?: string;
		timeoutMs?: number;
		isAlive?: (pid: number) => boolean;
	} = {},
): Promise<T> {
	const dir = options.dir ?? path.join(homedir(), '.pappardelle', 'send-locks');
	const isAlive = options.isAlive ?? processIsAlive;
	const file = path.join(dir, `${session}.lock`);
	const deadline = Date.now() + (options.timeoutMs ?? 30_000);
	await mkdir(dir, {recursive: true});
	for (;;) {
		try {
			await writeFile(file, `${process.pid}\n`, {flag: 'wx'});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}

		const holder = await readHolder(file);
		if (holder === null ? await isOld(file) : !isAlive(holder)) {
			await unlink(file).catch(() => {});
			continue;
		}

		if (Date.now() >= deadline) {
			throw new SendLockTimeout(`Another send to ${session} is still running`);
		}

		await delay(25);
	}

	try {
		return await task();
	} finally {
		await unlink(file).catch(() => {});
	}
}

// A lock file is empty for a moment between its creation and the pid write.
// One still empty long after that was left by a process that died in between.
async function isOld(file: string): Promise<boolean> {
	try {
		const {mtimeMs} = await stat(file);
		return Date.now() - mtimeMs > 5000;
	} catch {
		return false;
	}
}

async function readHolder(file: string): Promise<number | null> {
	try {
		const holder = Number.parseInt(await readFile(file, 'utf8'), 10);
		return Number.isInteger(holder) ? holder : null;
	} catch {
		return null;
	}
}
