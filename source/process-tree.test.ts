import {spawn} from 'node:child_process';
import {test, expect} from 'bun:test';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {depthBelow, parsePsListing, systemProcesses} from './process-tree.ts';

test('a child process is found with its parent, user, start time and directory', async () => {
	const dir = tempDir('process-tree-');
	const child = spawn('sleep', ['30'], {cwd: dir});
	teardown(() => child.kill());
	await new Promise(resolve => {
		child.once('spawn', resolve);
	});
	const info = systemProcesses.processes().get(child.pid!);
	expect(info).toMatchObject({
		pid: child.pid,
		ppid: process.pid,
		uid: process.getuid!(),
	});
	expect(info!.started).toMatch(/\d{2}:\d{2}:\d{2}/);
	expect(systemProcesses.cwd(child.pid!)).toBe(dir);
	expect(depthBelow(systemProcesses.processes(), child.pid!, process.pid)).toBe(
		1,
	);
});

test('a process that is gone has no directory', () => {
	expect(systemProcesses.cwd(2 ** 22 + 7)).toBeUndefined();
});

test('ps lines parse with the start time kept whole', () => {
	const listing = parsePsListing(
		'    1     0     0 Thu Nov 26 18:43:17 2026\n  812     1  1000 Fri Nov 27 03:07:41 2026\n',
	);
	expect(listing.get(812)).toStrictEqual({
		pid: 812,
		ppid: 1,
		uid: 1000,
		started: 'Fri Nov 27 03:07:41 2026',
	});
});

test('depth counts the parents up to the pane process and stops outside it', () => {
	const tree = parsePsListing(
		['1 0 0 a', '10 1 5 a', '11 10 5 a', '12 11 5 a', '20 1 5 a'].join('\n'),
	);
	expect(depthBelow(tree, 10, 10)).toBe(0);
	expect(depthBelow(tree, 12, 10)).toBe(2);
	expect(depthBelow(tree, 20, 10)).toBeUndefined();
	expect(depthBelow(tree, 99, 10)).toBeUndefined();
});
