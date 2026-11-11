import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	getHighlightFilePath,
	writeHighlightTarget,
	readHighlightTarget,
	clearHighlightTarget,
	findSpaceIndexByIssueKey,
	watchHighlightTarget,
	type HighlightRequest,
} from './highlight.ts';
import type {SpaceData} from './types.ts';

let tempCounter = 0;
function tempDir(): string {
	const dir = path.join(
		os.tmpdir(),
		`pappardelle-highlight-test-${process.pid}-${Date.now()}-${tempCounter++}`,
	);
	fs.mkdirSync(dir, {recursive: true});
	return dir;
}

// ============================================================================
// getHighlightFilePath
// ============================================================================

test('getHighlightFilePath returns path under repos/{repoName}/', t => {
	const result = getHighlightFilePath('stardust-labs');
	t.true(result.includes('/repos/stardust-labs/highlight-target'));
	t.true(result.includes('.pappardelle'));
});

test('getHighlightFilePath returns different paths for different repos', t => {
	const path1 = getHighlightFilePath('stardust-labs');
	const path2 = getHighlightFilePath('pappa-chex');
	t.not(path1, path2);
});

// ============================================================================
// writeHighlightTarget / readHighlightTarget
// ============================================================================

test.serial('writeHighlightTarget writes issue key to file', t => {
	const baseDir = tempDir();
	writeHighlightTarget('my-repo', {issueKey: 'STA-313', focus: false}, baseDir);

	const filePath = path.join(baseDir, 'repos', 'my-repo', 'highlight-target');
	t.true(fs.existsSync(filePath));
	t.is(fs.readFileSync(filePath, 'utf-8').trim(), 'STA-313');
});

test.serial('readHighlightTarget reads the issue key', t => {
	const baseDir = tempDir();
	writeHighlightTarget('my-repo', {issueKey: 'STA-400', focus: false}, baseDir);
	t.deepEqual(readHighlightTarget('my-repo', baseDir), {
		issueKey: 'STA-400',
		focus: false,
	});
});

test.serial('readHighlightTarget reads a focus request', t => {
	const baseDir = tempDir();
	writeHighlightTarget('my-repo', {issueKey: 'main', focus: true}, baseDir);
	t.deepEqual(readHighlightTarget('my-repo', baseDir), {
		issueKey: 'main',
		focus: true,
	});
});

test.serial('readHighlightTarget returns null when no file exists', t => {
	const baseDir = tempDir();
	t.is(readHighlightTarget('no-repo', baseDir), null);
});

test.serial('writeHighlightTarget overwrites previous value', t => {
	const baseDir = tempDir();
	writeHighlightTarget('my-repo', {issueKey: 'STA-100', focus: false}, baseDir);
	writeHighlightTarget('my-repo', {issueKey: 'STA-200', focus: false}, baseDir);
	t.is(readHighlightTarget('my-repo', baseDir)?.issueKey, 'STA-200');
});

// ============================================================================
// clearHighlightTarget
// ============================================================================

test.serial('clearHighlightTarget removes the file', t => {
	const baseDir = tempDir();
	writeHighlightTarget('my-repo', {issueKey: 'STA-100', focus: false}, baseDir);
	clearHighlightTarget('my-repo', baseDir);
	t.is(readHighlightTarget('my-repo', baseDir), null);
});

test.serial('clearHighlightTarget is a no-op when no file exists', t => {
	const baseDir = tempDir();
	t.notThrows(() => clearHighlightTarget('my-repo', baseDir));
});

// ============================================================================
// findSpaceIndexByIssueKey
// ============================================================================

const makeSpace = (name: string): SpaceData => ({
	name,
	worktreePath: `/worktrees/${name}`,
});

test('findSpaceIndexByIssueKey finds exact match', t => {
	const spaces = [
		makeSpace('STA-100'),
		makeSpace('STA-200'),
		makeSpace('STA-300'),
	];
	t.is(findSpaceIndexByIssueKey(spaces, 'STA-200'), 1);
});

test('findSpaceIndexByIssueKey returns -1 when not found', t => {
	const spaces = [makeSpace('STA-100'), makeSpace('STA-200')];
	t.is(findSpaceIndexByIssueKey(spaces, 'STA-999'), -1);
});

test('findSpaceIndexByIssueKey handles empty spaces array', t => {
	t.is(findSpaceIndexByIssueKey([], 'STA-100'), -1);
});

test('findSpaceIndexByIssueKey is case-insensitive', t => {
	const spaces = [makeSpace('STA-100'), makeSpace('STA-200')];
	t.is(findSpaceIndexByIssueKey(spaces, 'sta-200'), 1);
});

test('findSpaceIndexByIssueKey matches first occurrence', t => {
	const spaces = [
		makeSpace('STA-100'),
		makeSpace('STA-200'),
		makeSpace('STA-100'),
	];
	t.is(findSpaceIndexByIssueKey(spaces, 'STA-100'), 0);
});

// ============================================================================
// watchHighlightTarget
// ============================================================================

async function nextRequest(
	baseDir: string,
	request: HighlightRequest,
): Promise<HighlightRequest> {
	return new Promise(resolve => {
		const unwatch = watchHighlightTarget(
			'my-repo',
			received => {
				unwatch();
				resolve(received);
			},
			baseDir,
		);
		// Write after a short delay to ensure watcher is ready
		setTimeout(() => writeHighlightTarget('my-repo', request, baseDir), 50);
	});
}

test.serial('watchHighlightTarget delivers a plain highlight', async t => {
	const request = {issueKey: 'STA-500', focus: false};
	t.deepEqual(await nextRequest(tempDir(), request), request);
});

test.serial('watchHighlightTarget delivers a focus request', async t => {
	const request = {issueKey: 'main', focus: true};
	t.deepEqual(await nextRequest(tempDir(), request), request);
});

test.serial(
	'watchHighlightTarget unwatch stops callback from firing',
	async t => {
		const baseDir = tempDir();
		let calls = 0;
		const unwatch = watchHighlightTarget(
			'my-repo',
			() => {
				calls++;
			},
			baseDir,
		);
		unwatch();
		writeHighlightTarget(
			'my-repo',
			{issueKey: 'STA-600', focus: false},
			baseDir,
		);
		await new Promise(resolve => {
			setTimeout(resolve, 100);
		});
		t.is(calls, 0);
	},
);
