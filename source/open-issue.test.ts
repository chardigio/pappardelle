import {test, expect} from 'bun:test';
import {openIssueForKey} from './open-issue.ts';

const urlTracker = {
	buildIssueUrl: (issueKey: string) => `https://example.test/${issueKey}`,
};

test('a tracker that shows issues in place is used instead of the browser', async () => {
	const opened: string[] = [];
	const shown: string[] = [];

	const result = await openIssueForKey('bd-a1b2', {
		createTracker: () => ({
			...urlTracker,
			async openIssue(issueKey: string) {
				shown.push(issueKey);
				return true;
			},
		}),
		openUrl: (url: string) => opened.push(url),
	});

	expect(shown).toStrictEqual(['bd-a1b2']);
	expect(opened).toStrictEqual([]);
	expect(result).toStrictEqual({ok: true, message: 'Showing bd-a1b2'});
});

test('an in-place tracker that cannot display reports it without falling back to the browser', async () => {
	const opened: string[] = [];

	const result = await openIssueForKey('bd-a1b2', {
		createTracker: () => ({...urlTracker, openIssue: async () => false}),
		openUrl: (url: string) => opened.push(url),
	});

	expect(opened).toStrictEqual([]);
	expect(result).toStrictEqual({
		ok: false,
		message: 'Cannot show issue outside tmux',
	});
});

test('a tracker with a web UI opens the issue URL', async () => {
	const opened: string[] = [];

	const result = await openIssueForKey('STA-123', {
		createTracker: () => urlTracker,
		openUrl: (url: string) => opened.push(url),
	});

	expect(opened).toStrictEqual(['https://example.test/STA-123']);
	expect(result).toStrictEqual({ok: true, message: 'Opened STA-123'});
});

test('a tracker that cannot be constructed fails without throwing', async () => {
	const result = await openIssueForKey('STA-123', {
		createTracker() {
			throw new Error('no tracker configured');
		},
	});

	expect(result).toStrictEqual({ok: false, message: 'Failed to look up issue'});
});

test('a URL that cannot be built fails without throwing', async () => {
	const result = await openIssueForKey('STA-123', {
		createTracker: () => ({
			buildIssueUrl() {
				throw new Error('no base_url');
			},
		}),
		openUrl: () => undefined,
	});

	expect(result).toStrictEqual({ok: false, message: 'Failed to look up issue'});
});
