import {mkdirSync, mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {sameFile} from './same-file.ts';

test('a tmux-style socket matches itself through a symlinked directory', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'same-file-'));
	teardown(() => rmSync(dir, {recursive: true, force: true}));
	const socket = join(dir, 'real', 'default');
	mkdirSync(join(dir, 'real'));
	symlinkSync(join(dir, 'real'), join(dir, 'link'));
	const server = createServer();
	await new Promise<void>(resolve => {
		server.listen(socket, resolve);
	});
	teardown(() => server.close());
	const other = join(dir, 'real', 'other');
	const otherServer = createServer();
	await new Promise<void>(resolve => {
		otherServer.listen(other, resolve);
	});
	teardown(() => otherServer.close());

	expect(sameFile(join(dir, 'link', 'default'), socket)).toBe(true);
	expect(sameFile(join(dir, 'link', 'default'), other)).toBe(false);
});
