import {mkdir, open, stat, unlink, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {processIsAlive} from './tui-marker.ts';

export class SendLockTimeout extends Error {}

/** How long a send waits for another send to the same agent. */
export const SEND_LOCK_TIMEOUT_MS = 30_000;

// No send holds the lock for long, so one held past the timeout was left by a
// sender that died, even when its pid has since been reused by a live process.
const ABANDONED_LOCK_MS = SEND_LOCK_TIMEOUT_MS;

// A lock file is empty for a moment between its creation and the pid write,
// and a takeover guard exists only while one stale lock is removed. Either one
// still there after this was left by a process that died in between.
const HALF_WRITTEN_MS = 5000;

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
	const deadline = Date.now() + (options.timeoutMs ?? SEND_LOCK_TIMEOUT_MS);
	await mkdir(dir, {recursive: true});
	let own: FileId;
	for (;;) {
		try {
			await writeFile(file, `${process.pid}\n`, {flag: 'wx'});
			own = fileId(await stat(file, {bigint: true}));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}

		const holder = await readHolder(file);
		if (holder && isStale(holder, isAlive)) {
			await removeStale(file, holder.id);
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
		// A sender judged dead (its pid unseen from another PID namespace, say)
		// may find its lock taken over, and must leave the new holder's alone.
		await unlinkIfSame(file, own);
	}
}

// A file's inode number alone can be handed straight to the next file on
// ext4 and xfs, so a lock is identified by inode and change time together.
type FileId = {ino: bigint; ctimeNs: bigint};
type Holder = {pid: number | null; id: FileId; mtimeMs: number};

function isStale(holder: Holder, isAlive: (pid: number) => boolean) {
	const age = Date.now() - holder.mtimeMs;
	if (holder.pid === null) return age > HALF_WRITTEN_MS;
	return age > ABANDONED_LOCK_MS || !isAlive(holder.pid);
}

function fileId(stats: {ino: bigint; ctimeNs: bigint}): FileId {
	return {ino: stats.ino, ctimeNs: stats.ctimeNs};
}

async function unlinkIfSame(file: string, id: FileId): Promise<void> {
	const current = await stat(file, {bigint: true}).catch(() => undefined);
	if (current?.ino === id.ino && current.ctimeNs === id.ctimeNs) {
		await unlink(file).catch(() => {});
	}
}

// Two senders can both find the same stale lock, and the slower one would
// delete the fresh lock the faster one created after removing it. Removals
// take turns behind a guard file, and each removes only the file it judged.
async function removeStale(file: string, stale: FileId): Promise<void> {
	const guard = `${file}.takeover`;
	try {
		await writeFile(guard, '', {flag: 'wx'});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		const guardStat = await stat(guard).catch(() => undefined);
		if (guardStat && Date.now() - guardStat.mtimeMs > HALF_WRITTEN_MS) {
			await unlink(guard).catch(() => {});
		}

		return;
	}

	try {
		await unlinkIfSame(file, stale);
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
		const stats = await handle.stat({bigint: true});
		const pid = Number.parseInt(await handle.readFile('utf8'), 10);
		return {
			pid: Number.isInteger(pid) ? pid : null,
			id: fileId(stats),
			mtimeMs: Number(stats.mtimeMs),
		};
	} finally {
		await handle.close();
	}
}
