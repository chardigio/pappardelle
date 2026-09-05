import test from 'ava';
import {openIssueForKey} from './open-issue.ts';

const urlTracker = {
	buildIssueUrl: (issueKey: string) => `https://example.test/${issueKey}`,
};

test('a tracker that shows issues in place is used instead of the browser', t => {
	const opened: string[] = [];
	const shown: string[] = [];

	const result = openIssueForKey('bd-a1b2', {
		createTracker: () => ({
			...urlTracker,
			openIssue(issueKey: string) {
				shown.push(issueKey);
				return true;
			},
		}),
		openUrl: (url: string) => opened.push(url),
	});

	t.deepEqual(shown, ['bd-a1b2']);
	t.deepEqual(opened, []);
	t.deepEqual(result, {ok: true, message: 'Showing bd-a1b2'});
});

test('an in-place tracker that cannot display reports it without falling back to the browser', t => {
	const opened: string[] = [];

	const result = openIssueForKey('bd-a1b2', {
		createTracker: () => ({...urlTracker, openIssue: () => false}),
		openUrl: (url: string) => opened.push(url),
	});

	t.deepEqual(opened, []);
	t.deepEqual(result, {ok: false, message: 'Cannot show issue outside tmux'});
});

test('a tracker with a web UI opens the issue URL', t => {
	const opened: string[] = [];

	const result = openIssueForKey('STA-123', {
		createTracker: () => urlTracker,
		openUrl: (url: string) => opened.push(url),
	});

	t.deepEqual(opened, ['https://example.test/STA-123']);
	t.deepEqual(result, {ok: true, message: 'Opened STA-123'});
});

test('a tracker that cannot be constructed fails without throwing', t => {
	const result = openIssueForKey('STA-123', {
		createTracker() {
			throw new Error('no tracker configured');
		},
	});

	t.deepEqual(result, {ok: false, message: 'Failed to look up issue'});
});

test('a URL that cannot be built fails without throwing', t => {
	const result = openIssueForKey('STA-123', {
		createTracker: () => ({
			buildIssueUrl() {
				throw new Error('no base_url');
			},
		}),
		openUrl: () => undefined,
	});

	t.deepEqual(result, {ok: false, message: 'Failed to look up issue'});
});
