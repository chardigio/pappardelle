import test from 'ava';
import {openPR} from './open-pr.ts';
import type {PRLink} from './providers/types.ts';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((_resolve, _reject) => {
		resolve = _resolve;
		reject = _reject;
	});
	return {promise, resolve, reject};
}

test('rapid requests only open and report the latest result', async t => {
	const first = deferred<PRLink | null>();
	const second = deferred<PRLink | null>();
	const keys: string[] = [];
	const urls: string[] = [];
	const messages: string[] = [];
	let latest = 1;
	const options = {
		provider: {
			async getPRLink(key: string) {
				keys.push(key);
				return key === 'FIRST' ? first.promise : second.promise;
			},
		},
		ownsHeader: () => true,
		async openUrl(url: string) {
			urls.push(url);
		},
		showMessage(message: string) {
			messages.push(message);
		},
	};
	const firstRequest = openPR('FIRST', {
		...options,
		isLatest: () => latest === 1,
	});
	latest = 2;
	const secondRequest = openPR('SECOND', {
		...options,
		isLatest: () => latest === 2,
	});
	second.resolve({number: 2, url: 'https://github.com/org/repo/pull/2'});
	await secondRequest;
	first.resolve({number: 1, url: 'https://github.com/org/repo/pull/1'});
	await firstRequest;
	t.deepEqual(keys, ['FIRST', 'SECOND']);
	t.deepEqual(urls, ['https://github.com/org/repo/pull/2']);
	t.deepEqual(messages, ['Opened PR #2']);
});

test('an unrelated header message during the lookup still opens the PR without replacing that message', async t => {
	const lookup = deferred<PRLink | null>();
	let ownsHeader = true;
	const urls: string[] = [];
	const messages: string[] = [];
	const request = openPR('STA-1', {
		provider: {
			async getPRLink() {
				return lookup.promise;
			},
		},
		isLatest: () => true,
		ownsHeader: () => ownsHeader,
		async openUrl(url) {
			urls.push(url);
		},
		showMessage(message) {
			messages.push(message);
		},
	});
	ownsHeader = false;
	lookup.resolve({number: 7, url: 'https://github.com/org/repo/pull/7'});
	await request;
	t.deepEqual(urls, ['https://github.com/org/repo/pull/7']);
	t.deepEqual(messages, []);
});

for (const outcome of ['missing', 'lookup failure'] as const) {
	test(`a ${outcome} result does not replace newer unrelated header feedback`, async t => {
		const messages: string[] = [];
		await openPR('STA-1', {
			provider: {
				async getPRLink() {
					if (outcome === 'lookup failure') throw new Error('unavailable');
					return null;
				},
			},
			isLatest: () => true,
			ownsHeader: () => false,
			async openUrl() {
				t.fail('no PR must not launch a browser');
			},
			showMessage(message) {
				messages.push(message);
			},
		});
		t.deepEqual(messages, []);
	});
}

test('a superseded lookup failure does not replace a newer action message', async t => {
	const lookup = deferred<PRLink | null>();
	let latest = true;
	const messages: string[] = [];
	const request = openPR('FIRST', {
		provider: {
			async getPRLink() {
				return lookup.promise;
			},
		},
		isLatest: () => latest,
		ownsHeader: () => true,
		async openUrl() {
			t.fail('failed lookup must not launch a browser');
		},
		showMessage(message) {
			messages.push(message);
		},
	});
	latest = false;
	lookup.reject(new Error('lookup failed'));
	await request;
	t.deepEqual(messages, []);
});

for (const fails of [false, true]) {
	test(`late browser ${fails ? 'failure' : 'success'} does not replace a newer header message`, async t => {
		const launch = deferred<void>();
		const started = deferred<void>();
		let ownsHeader = true;
		const messages: string[] = [];
		const request = openPR('FIRST', {
			provider: {
				async getPRLink() {
					return {number: 1, url: 'https://example.com/pr/1'};
				},
			},
			isLatest: () => true,
			ownsHeader: () => ownsHeader,
			async openUrl() {
				started.resolve();
				return launch.promise;
			},
			showMessage(message) {
				messages.push(message);
			},
		});
		await started.promise;
		ownsHeader = false;
		if (fails) launch.reject(new Error('open failed'));
		else launch.resolve();
		await request;
		t.deepEqual(messages, []);
	});
}

for (const outcome of [
	'missing',
	'lookup failure',
	'launch failure',
] as const) {
	test(`current request reports ${outcome}`, async t => {
		const messages: string[] = [];
		await openPR('STA-1', {
			provider: {
				async getPRLink() {
					if (outcome === 'lookup failure') throw new Error('unavailable');
					return outcome === 'missing'
						? null
						: {number: 1, url: 'https://example.com/pr/1'};
				},
			},
			isLatest: () => true,
			ownsHeader: () => true,
			async openUrl() {
				throw new Error('open unavailable');
			},
			showMessage(message) {
				messages.push(message);
			},
		});
		t.deepEqual(messages, [
			outcome === 'missing'
				? 'No PR found for STA-1'
				: outcome === 'lookup failure'
					? 'Failed to look up PR'
					: 'Could not launch open',
		]);
	});
}
