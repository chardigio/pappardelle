import test from 'ava';
import {tmuxVersionTooOld} from './tmux-version.ts';

test('releases before 3.3 are too old', t => {
	for (const version of ['3.2a', '3.2', '3.1c', '2.9', '1.8']) {
		t.true(tmuxVersionTooOld(version), `version ${version}`);
	}
});

test('3.3 and later meet the floor', t => {
	for (const version of ['3.3', '3.3a', '3.6', '3.8', '3.10', '4.0']) {
		t.false(tmuxVersionTooOld(version), `version ${version}`);
	}
});

test('preview builds compare by their release number', t => {
	t.false(tmuxVersionTooOld('next-3.9'));
});

test('a version without a release number never blocks startup', t => {
	t.false(tmuxVersionTooOld('master'));
	t.false(tmuxVersionTooOld(''));
});
