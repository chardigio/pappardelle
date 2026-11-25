import {test, expect} from 'bun:test';
import {unreachable} from '../test/helpers/unreachable.ts';
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

test('rapid requests only open and report the latest result', async () => {
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
	expect(keys).toStrictEqual(['FIRST', 'SECOND']);
	expect(urls).toStrictEqual(['https://github.com/org/repo/pull/2']);
	expect(messages).toStrictEqual(['Opened PR #2']);
});

test('an unrelated header message during the lookup still opens the PR without replacing that message', async () => {
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
	expect(urls).toStrictEqual(['https://github.com/org/repo/pull/7']);
	expect(messages).toStrictEqual([]);
});

for (const outcome of ['missing', 'lookup failure'] as const) {
	test(`a ${outcome} result does not replace newer unrelated header feedback`, async () => {
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
				unreachable('no PR must not launch a browser');
			},
			showMessage(message) {
				messages.push(message);
			},
		});
		expect(messages).toStrictEqual([]);
	});
}

test('a superseded lookup failure does not replace a newer action message', async () => {
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
			unreachable('failed lookup must not launch a browser');
		},
		showMessage(message) {
			messages.push(message);
		},
	});
	latest = false;
	lookup.reject(new Error('lookup failed'));
	await request;
	expect(messages).toStrictEqual([]);
});

for (const fails of [false, true]) {
	test(`late browser ${fails ? 'failure' : 'success'} does not replace a newer header message`, async () => {
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
		expect(messages).toStrictEqual([]);
	});
}

for (const outcome of [
	'missing',
	'lookup failure',
	'launch failure',
] as const) {
	test(`current request reports ${outcome}`, async () => {
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
		expect(messages).toStrictEqual([
			outcome === 'missing'
				? 'No PR found for STA-1'
				: outcome === 'lookup failure'
					? 'Failed to look up PR'
					: 'Could not launch open',
		]);
	});
}

test('a PR recorded by link-pr opens without the issue-key lookup', async () => {
	const urls: string[] = [];
	let lookedUp = false;
	await openPR('STA-1', {
		provider: {
			async getPRLink() {
				lookedUp = true;
				return null;
			},
		},
		linked: {url: 'https://github.com/o/nested/pull/7', number: 7},
		isLatest: () => true,
		ownsHeader: () => true,
		async openUrl(url) {
			urls.push(url);
		},
		showMessage() {},
	});
	expect(urls).toStrictEqual(['https://github.com/o/nested/pull/7']);
	expect(lookedUp).toBe(false);
});
