import {test, expect} from 'bun:test';
import {tmuxVersionTooOld} from './tmux-version.ts';

test('releases before 3.3 are too old', () => {
	for (const version of ['3.2a', '3.2', '3.1c', '2.9', '1.8']) {
		expect(tmuxVersionTooOld(version), `version ${version}`).toBe(true);
	}
});

test('3.3 and later meet the floor', () => {
	for (const version of ['3.3', '3.3a', '3.6', '3.8', '3.10', '4.0']) {
		expect(tmuxVersionTooOld(version), `version ${version}`).toBe(false);
	}
});

test('preview builds compare by their release number', () => {
	expect(tmuxVersionTooOld('next-3.9')).toBe(false);
});

test('a version without a release number never blocks startup', () => {
	expect(tmuxVersionTooOld('master')).toBe(false);
	expect(tmuxVersionTooOld('')).toBe(false);
});
