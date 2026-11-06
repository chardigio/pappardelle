import {mkdirSync, mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {sameFile} from './same-file.ts';

test('a tmux-style socket matches itself through a symlinked directory', async t => {
	const dir = mkdtempSync(join(tmpdir(), 'same-file-'));
	t.teardown(() => rmSync(dir, {recursive: true, force: true}));
	const socket = join(dir, 'real', 'default');
	mkdirSync(join(dir, 'real'));
	symlinkSync(join(dir, 'real'), join(dir, 'link'));
	const server = createServer();
	await new Promise<void>(resolve => {
		server.listen(socket, resolve);
	});
	t.teardown(() => server.close());
	const other = join(dir, 'real', 'other');
	const otherServer = createServer();
	await new Promise<void>(resolve => {
		otherServer.listen(other, resolve);
	});
	t.teardown(() => otherServer.close());

	t.true(sameFile(join(dir, 'link', 'default'), socket));
	t.false(sameFile(join(dir, 'link', 'default'), other));
});
