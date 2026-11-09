import {mkdir, open, stat, unlink, writeFile} from 'node:fs/promises';
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
		if (
			holder &&
			(holder.pid === null ? isOld(holder) : !isAlive(holder.pid))
		) {
			await removeStale(file, holder.ino);
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

type Holder = {pid: number | null; ino: number; mtimeMs: number};

// A lock file is empty for a moment between its creation and the pid write.
// One still empty long after that was left by a process that died in between.
function isOld(holder: Holder): boolean {
	return Date.now() - holder.mtimeMs > 5000;
}

// Two senders can both find the same stale lock, and the slower one would
// delete the fresh lock the faster one created after removing it. Removals
// take turns behind a guard file, and each removes only the file it judged.
async function removeStale(file: string, staleIno: number): Promise<void> {
	const guard = `${file}.takeover`;
	try {
		await writeFile(guard, '', {flag: 'wx'});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		const guardStat = await stat(guard).catch(() => undefined);
		if (guardStat && Date.now() - guardStat.mtimeMs > 5000) {
			await unlink(guard).catch(() => {});
		}

		return;
	}

	try {
		const current = await stat(file).catch(() => undefined);
		if (current?.ino === staleIno) await unlink(file).catch(() => {});
	} finally {
		await unlink(guard).catch(() => {});
	}
}

async function readHolder(file: string): Promise<Holder | undefined> {
	let handle;
	try {
		handle = await open(file, 'r');
	} catch {
		return undefined;
	}

	try {
		const {ino, mtimeMs} = await handle.stat();
		const pid = Number.parseInt(await handle.readFile('utf8'), 10);
		return {pid: Number.isInteger(pid) ? pid : null, ino, mtimeMs};
	} finally {
		await handle.close();
	}
}
