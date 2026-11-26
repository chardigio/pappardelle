import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {
	BULK_BATCH_SIZE,
	makeLinearGraphQLClient,
	resolveApiKey,
	type FetchLike,
} from './providers/linear-graphql.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';

// ============================================================================
// Helpers
// ============================================================================

function fakeIssuePayload(identifier: string, title = `T-${identifier}`) {
	return {
		identifier,
		title,
		state: {name: 'In Progress', type: 'started', color: '#f2c94c'},
		project: {name: 'P'},
		labels: {nodes: [{name: 'bug'}]},
	};
}

function okJsonResponse(data: Record<string, unknown>) {
	return {
		ok: true,
		status: 200,
		async text() {
			return JSON.stringify({data});
		},
		async json() {
			return {data};
		},
	};
}

function okJsonResponseWithErrors(
	data: Record<string, unknown> | undefined,
	errors: Array<{message: string}>,
) {
	return {
		ok: true,
		status: 200,
		async text() {
			return JSON.stringify({data, errors});
		},
		async json() {
			return {data, errors};
		},
	};
}

function errorResponse(status: number, body = 'oops') {
	return {
		ok: false,
		status,
		async text() {
			return body;
		},
		async json() {
			return {};
		},
	};
}

// ============================================================================
// Happy path
// ============================================================================

test('returns empty Map for empty issueKeys (no HTTP call)', async () => {
	let calls = 0;
	const fetchImpl: FetchLike = async () => {
		calls++;
		return okJsonResponse({});
	};

	const client = makeLinearGraphQLClient({apiKey: 'k', fetchImpl});
	const result = await client([]);

	expect(calls).toBe(0);
	expect(result!.size).toBe(0);
});

test('single batch — parses every alias and maps back to its key', async () => {
	const fetchImpl: FetchLike = async () =>
		okJsonResponse({
			i0: fakeIssuePayload('STA-1'),
			i1: fakeIssuePayload('STA-2'),
		});

	const client = makeLinearGraphQLClient({apiKey: 'k', fetchImpl});
	const result = await client(['STA-1', 'STA-2']);

	expect(result).toBeTruthy();
	expect(result!.size).toBe(2);
	expect(result!.get('STA-1')!.identifier).toBe('STA-1');
	expect(result!.get('STA-2')!.title).toBe('T-STA-2');
	expect(result!.get('STA-1')!.labels).toStrictEqual(['bug']);
});

test('url field passes through bulk-fetch onto the cached TrackerIssue', async () => {
	// Without this, LinearProvider.buildIssueUrl can't resolve a cross-
	// workspace URL from the bulk path's cache and silently falls back to
	// the hardcoded stardust-labs slug for WAB-* spaces.
	const fetchImpl: FetchLike = async () =>
		okJsonResponse({
			i0: {
				...fakeIssuePayload('WAB-5'),
				url: 'https://linear.app/wabo-ventures/issue/WAB-5/add-new-ads-tab',
			},
		});

	const client = makeLinearGraphQLClient({apiKey: 'k', fetchImpl});
	const result = await client(['WAB-5']);

	expect(result!.get('WAB-5')!.url).toBe(
		'https://linear.app/wabo-ventures/issue/WAB-5/add-new-ads-tab',
	);
});

test('url field absent from bulk-fetch response → issue.url is undefined', async () => {
	// The conditional spread in parseGraphQLIssue should leave url unset
	// when the API didn't include it, so buildIssueUrl can fall back to
	// its hardcoded-slug branch instead of using a stale or empty URL.
	const fetchImpl: FetchLike = async () =>
		okJsonResponse({i0: fakeIssuePayload('STA-1')});

	const client = makeLinearGraphQLClient({apiKey: 'k', fetchImpl});
	const result = await client(['STA-1']);

	expect(result!.get('STA-1')!.url).toBe(undefined);
});

test('sends the API key in the Authorization header', async () => {
	let captured: Record<string, string> | null = null;
	const fetchImpl: FetchLike = async (_url, init) => {
		captured = init.headers;
		return okJsonResponse({i0: fakeIssuePayload('STA-9')});
	};

	const client = makeLinearGraphQLClient({apiKey: 'lin_secret', fetchImpl});
	await client(['STA-9']);

	expect(captured).toBeTruthy();
	expect(captured!['Authorization']).toBe('lin_secret');
	expect(captured!['Content-Type']).toBe('application/json');
});

// ============================================================================
// Batching (STA-1377 review feedback — query complexity ceiling)
// ============================================================================

test(`BULK_BATCH_SIZE constant is ${BULK_BATCH_SIZE}`, () => {
	// Sanity-check the public constant so an accidental change to it has to
	// touch the test too — a heuristic ceiling tied to Linear's complexity
	// budget shouldn't drift silently.
	expect(BULK_BATCH_SIZE).toBe(25);
});

test('splits issueKeys into batches of batchSize', async () => {
	const batchSizes: number[] = [];
	const fetchImpl: FetchLike = async (_url, init) => {
		const body = JSON.parse(init.body) as {query: string};
		batchSizes.push((body.query.match(/issue\(/g) ?? []).length);
		// Synthesize one payload per alias in this batch
		const aliases = body.query.match(/i\d+:/g) ?? [];
		const data: Record<string, unknown> = {};
		for (const a of aliases) {
			const key = a.slice(0, -1); // strip ':'
			data[key] = fakeIssuePayload(key);
		}

		return okJsonResponse(data);
	};

	const client = makeLinearGraphQLClient({
		apiKey: 'k',
		fetchImpl,
		batchSize: 3,
	});
	const keys = Array.from({length: 7}, (_, i) => `STA-${i + 1}`);
	const result = await client(keys);

	expect(batchSizes).toStrictEqual([3, 3, 1]);
	expect(result!.size).toBe(7);
	// Every original key resolves to a non-null issue
	for (const k of keys) expect(result!.get(k)).toBeTruthy();
});

test('total failure in any batch returns null — CLI fallback covers the whole desk', async () => {
	let callIndex = 0;
	const fetchImpl: FetchLike = async () => {
		callIndex++;
		if (callIndex === 2) return errorResponse(503);
		return okJsonResponse({i0: fakeIssuePayload('STA-fine')});
	};

	const client = makeLinearGraphQLClient({
		apiKey: 'k',
		fetchImpl,
		batchSize: 1,
	});
	const result = await client(['STA-1', 'STA-2', 'STA-3']);

	expect(result, 'one batch failure should null the entire response').toBe(
		null,
	);
});

// ============================================================================
// Error paths
// ============================================================================

test('HTTP 401 returns null (CLI fallback)', async () => {
	const fetchImpl: FetchLike = async () => errorResponse(401, 'unauthorized');
	const client = makeLinearGraphQLClient({apiKey: 'k', fetchImpl});
	const result = await client(['STA-1']);
	expect(result).toBe(null);
});

test('HTTP 500 returns null (CLI fallback)', async () => {
	const fetchImpl: FetchLike = async () => errorResponse(500, 'internal error');
	const client = makeLinearGraphQLClient({apiKey: 'k', fetchImpl});
	const result = await client(['STA-1']);
	expect(result).toBe(null);
});

test('fetch throw returns null (network error → CLI fallback)', async () => {
	const fetchImpl: FetchLike = async () => {
		throw new Error('ECONNRESET');
	};

	const client = makeLinearGraphQLClient({apiKey: 'k', fetchImpl});
	const result = await client(['STA-1']);
	expect(result).toBe(null);
});

test('aborts when timeout fires before fetch resolves', async () => {
	let abortFired = false;
	const fetchImpl: FetchLike = async (_url, init) =>
		new Promise((_resolve, reject) => {
			init.signal.addEventListener('abort', () => {
				abortFired = true;
				reject(new Error('aborted'));
			});
			// Never resolve — only the abort path will end this
		});

	const client = makeLinearGraphQLClient({
		apiKey: 'k',
		fetchImpl,
		timeoutMs: 50,
	});
	const result = await client(['STA-1']);
	expect(result).toBe(null);
	expect(abortFired, 'AbortController should fire on timeout').toBe(true);
});

// ============================================================================
// Partial / malformed responses
// ============================================================================

test('partial errors with data — returns Map, logs warning, keeps successful aliases', async () => {
	const fetchImpl: FetchLike = async () =>
		okJsonResponseWithErrors({i0: fakeIssuePayload('STA-1'), i1: null}, [
			{message: 'Issue STA-2 not accessible'},
		]);

	const client = makeLinearGraphQLClient({apiKey: 'k', fetchImpl});
	const result = await client(['STA-1', 'STA-2']);

	expect(result).toBeTruthy();
	expect(result!.size).toBe(2);
	expect(result!.get('STA-1')!.identifier).toBe('STA-1');
	expect(result!.get('STA-2'), 'unresolved alias maps to null in the Map').toBe(
		null,
	);
});

test('response with no data field — every key maps to null (per-key CLI fallback)', async () => {
	const fetchImpl: FetchLike = async () => ({
		ok: true,
		status: 200,
		async text() {
			return '{}';
		},
		async json() {
			return {};
		},
	});

	const client = makeLinearGraphQLClient({apiKey: 'k', fetchImpl});
	const result = await client(['STA-1', 'STA-2']);

	expect(
		result,
		'no data is *partial*, not total failure — Map preserved',
	).toBeTruthy();
	expect(result!.size).toBe(2);
	expect(result!.get('STA-1')).toBe(null);
	expect(result!.get('STA-2')).toBe(null);
});

test('alias with missing required fields parses to null', async () => {
	const fetchImpl: FetchLike = async () =>
		okJsonResponse({
			i0: {title: 'no identifier here', state: {name: 'S'}},
		});

	const client = makeLinearGraphQLClient({apiKey: 'k', fetchImpl});
	const result = await client(['STA-1']);
	expect(result!.get('STA-1')).toBe(null);
});

// ============================================================================
// resolveApiKey precedence — env var > disk
// ============================================================================

function tmpAuthFile(contents: string): string {
	const p = path.join(tempDir('pappardelle-test-auth-'), 'auth.json');
	fs.writeFileSync(p, contents);
	return p;
}

test('resolveApiKey prefers LINCTL_API_KEY env var over disk', () => {
	const disk = tmpAuthFile(JSON.stringify({api_key: 'disk-key'}));
	expect(resolveApiKey({LINCTL_API_KEY: 'env-key'}, disk)).toBe('env-key');
});

test('resolveApiKey trims whitespace around env var', () => {
	const disk = tmpAuthFile(JSON.stringify({api_key: 'disk-key'}));
	expect(resolveApiKey({LINCTL_API_KEY: '  env-key  '}, disk)).toBe('env-key');
});

test('resolveApiKey falls back to disk when env var is unset or empty', () => {
	const disk = tmpAuthFile(JSON.stringify({api_key: 'disk-key'}));
	expect(resolveApiKey({}, disk)).toBe('disk-key');
	expect(resolveApiKey({LINCTL_API_KEY: ''}, disk)).toBe('disk-key');
});

test('resolveApiKey returns null when neither env nor disk has a key', () => {
	const missing = path.join(tempDir('pappardelle-test-auth-'), 'auth.json');
	expect(resolveApiKey({}, missing)).toBe(null);
});

test('resolveApiKey returns null on malformed disk file (and no env var)', () => {
	const disk = tmpAuthFile('not json at all');
	expect(resolveApiKey({}, disk)).toBe(null);
});

test('resolveApiKey returns null when disk has no api_key field', () => {
	const disk = tmpAuthFile(JSON.stringify({something: 'else'}));
	expect(resolveApiKey({}, disk)).toBe(null);
});
