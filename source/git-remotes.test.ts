import test from 'ava';
import {remoteProjects} from './git-remotes.ts';

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
