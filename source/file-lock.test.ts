import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test from 'ava';
import {withFileLock} from './file-lock.ts';

const execute = promisify(execFile);
const fileLockModule = fileURLToPath(new URL('file-lock.ts', import.meta.url));

/** What another process gets when it asks for the lock and gives up after 100 ms. */
async function lockFromAnotherProcess(target: string): Promise<string> {
	const script = `
		import {setLockTimingForTests, withFileLock} from ${JSON.stringify(fileLockModule)};
		setLockTimingForTests({timeoutMs: 100, retryMs: 5});
		console.log(await withFileLock(process.argv[1], () => 'entered').catch(() => 'kept out'));
	`;
	const {stdout} = await execute(process.execPath, ['-e', script, target]);
	return stdout.trim();
}

test('another process does not enter while the first caller’s async callback is pending', async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-lock-'));
	t.teardown(() => {
		fs.rmSync(directory, {recursive: true, force: true});
	});
	const target = path.join(directory, 'guarded');
	let finish!: () => void;
	const pending = new Promise<void>(resolve => {
		finish = resolve;
	});
	let entered!: () => void;
	const inside = new Promise<void>(resolve => {
		entered = resolve;
	});

	const first = withFileLock(target, async () => {
		entered();
		await pending;
		return 'done';
	});
	await inside;
	t.is(await lockFromAnotherProcess(target), 'kept out');

	finish();
	t.is(await first, 'done');
	t.is(await lockFromAnotherProcess(target), 'entered');
});
