import {test, expect} from 'bun:test';
import {readRemoteUrls, remoteProjects} from './git-remotes.ts';

test('a malformed remote URL is skipped instead of hiding the other remotes', () => {
	const output = [
		'remote.broken.url https://exa mple.com:99999/x/y',
		'remote.origin.url git@github.com:upstream/repo.git',
	].join('\n');
	expect([...remoteProjects(output, 'github.com')]).toStrictEqual([
		['origin', 'upstream/repo'],
	]);
});

test('a remote URL with a trailing slash names the same project', () => {
	const output = [
		'remote.origin.url https://github.com/o/r/',
		'remote.fork.url git@github.com:me/r.git/',
	].join('\n');
	expect([...remoteProjects(output, 'github.com')]).toStrictEqual([
		['origin', 'o/r'],
		['fork', 'me/r'],
	]);
});

test('a repository with no remotes reads as no remote URLs', async () => {
	const noMatch = Object.assign(new Error('Command failed'), {code: 1});
	expect(
		await readRemoteUrls(async () => {
			throw noMatch;
		}),
	).toBe('');
});
