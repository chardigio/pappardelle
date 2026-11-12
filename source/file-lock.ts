// Advisory file locks shared between Pappardelle processes. A lock is a
// directory next to the file it guards, holding one marker file named after
// its owner's pid, so a crashed owner's lock can be reclaimed.

import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

// Live owners keep their lock regardless of age. Empty abandoned lock
// directories can be removed after this grace period. Contention times out
// without running the mutation; callers can retry safely.
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 25;
let lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS;
let lockStaleMs = DEFAULT_LOCK_STALE_MS;
let lockRetryMs = DEFAULT_LOCK_RETRY_MS;

/**
 * Override advisory-lock timings for contention tests.
 */
export function setLockTimingForTests(opts: {
	timeoutMs?: number;
	staleMs?: number;
	retryMs?: number;
}): void {
	if (opts.timeoutMs !== undefined) lockTimeoutMs = opts.timeoutMs;
	if (opts.staleMs !== undefined) lockStaleMs = opts.staleMs;
	if (opts.retryMs !== undefined) lockRetryMs = opts.retryMs;
}

/**
 * Restore default advisory-lock timings (for testing cleanup).
 */
export function resetLockTimingForTests(): void {
	lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS;
	lockStaleMs = DEFAULT_LOCK_STALE_MS;
	lockRetryMs = DEFAULT_LOCK_RETRY_MS;
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to another user
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

const mutationQueues = new Map<string, Promise<unknown>>();

/**
 * Run `fn` while holding the advisory lock `${p}.lock`, shared with every
 * other process that locks the same path, until `fn` has returned and what it
 * returned has settled. Calls in this process queue behind each other. Times
 * out instead of running `fn` when the lock stays held.
 */
export async function withFileLock<T>(
	p: string,
	fn: (p: string) => T | Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const previous = mutationQueues.get(p) ?? Promise.resolve();
	const task = previous
		.catch(() => {})
		.then(async () => {
			signal?.throwIfAborted();
			const lockPath = `${p}.lock`;
			fs.mkdirSync(path.dirname(lockPath), {recursive: true});
			const owner = `${process.pid}-${randomUUID()}`;
			const marker = path.join(lockPath, owner);
			const deadline = Date.now() + lockTimeoutMs;
			for (;;) {
				signal?.throwIfAborted();
				let acquired = false;
				try {
					fs.mkdirSync(lockPath);
					try {
						fs.writeFileSync(marker, '', {flag: 'wx'});
						// A dead-owner reaper may remove an empty directory while its creator
						// is descheduled. Only the sole marker owner may enter the critical section.
						const entries = fs.readdirSync(lockPath);
						if (entries.length === 1 && entries[0] === owner) {
							acquired = true;
						}
					} finally {
						if (!acquired) {
							fs.rmSync(marker, {force: true});
							removeEmptyLock(lockPath);
						}
					}
				} catch (err) {
					if (
						!['EEXIST', 'ENOENT'].includes(
							(err as NodeJS.ErrnoException).code ?? '',
						)
					)
						throw err;
					reapDeadOwners(lockPath);
				}
				if (acquired) {
					try {
						signal?.throwIfAborted();
						return await fn(p);
					} finally {
						fs.rmSync(marker, {force: true});
						removeEmptyLock(lockPath);
					}
				}
				if (Date.now() >= deadline)
					throw new Error(`Lock timed out after ${lockTimeoutMs}ms: ${p}`);
				await delay(lockRetryMs, undefined, {signal});
			}
		});
	mutationQueues.set(p, task);
	try {
		return await task;
	} finally {
		if (mutationQueues.get(p) === task) mutationQueues.delete(p);
	}
}

function removeEmptyLock(lockPath: string): void {
	try {
		fs.rmdirSync(lockPath);
	} catch (err) {
		if (
			!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(
				(err as NodeJS.ErrnoException).code ?? '',
			)
		)
			throw err;
	}
}

function reapDeadOwners(lockPath: string): void {
	try {
		const entries = fs.readdirSync(lockPath);
		let removed = false;
		for (const entry of entries) {
			const match = /^(\d+)-[\da-f-]+$/.exec(entry);
			if (match && !isPidAlive(Number(match[1]))) {
				// A unique filename prevents a concurrent reaper from deleting a new
				// holder's marker after the dead owner's directory has been replaced.
				fs.rmSync(path.join(lockPath, entry), {force: true});
				removed = true;
			}
		}
		if (
			removed ||
			(entries.length === 0 &&
				Date.now() - fs.statSync(lockPath).mtimeMs > lockStaleMs)
		)
			removeEmptyLock(lockPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
}
