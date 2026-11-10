import test from 'ava';
import {readRemoteUrls, remoteProjects} from './git-remotes.ts';

test('a malformed remote URL is skipped instead of hiding the other remotes', t => {
	const output = [
		'remote.broken.url https://exa mple.com:99999/x/y',
		'remote.origin.url git@github.com:upstream/repo.git',
	].join('\n');
	t.deepEqual(
		[...remoteProjects(output, 'github.com')],
		[['origin', 'upstream/repo']],
	);
});

test('a remote URL with a trailing slash names the same project', t => {
	const output = [
		'remote.origin.url https://github.com/o/r/',
		'remote.fork.url git@github.com:me/r.git/',
	].join('\n');
	t.deepEqual(
		[...remoteProjects(output, 'github.com')],
		[
			['origin', 'o/r'],
			['fork', 'me/r'],
		],
	);
});

test('a repository with no remotes reads as no remote URLs', async t => {
	const noMatch = Object.assign(new Error('Command failed'), {code: 1});
	t.is(
		await readRemoteUrls(async () => {
			throw noMatch;
		}),
		'',
	);
});
