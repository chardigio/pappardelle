// Default Linear GraphQL bulk-fetch client.
//
// Pappardelle invokes LinearProvider.getIssues once per workspace-list refresh
// (see app.tsx). Pre-STA-1377 that fanned N concurrent `linctl issue get`
// subprocesses, one per active worktree. This module replaces the N-process
// fan-out with batched aliased GraphQL POSTs against api.linear.app — the
// same pattern the GitHub rail-status code uses against gh.
//
// The API key comes from ~/.linctl-auth.json (already populated by
// `linctl auth login`). If the file is missing, malformed, or any request
// fails for any reason, this returns null and LinearProvider falls back to
// the per-issue CLI path so nothing regresses.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLogger} from '../logger.ts';
import {sanitizeSubprocessError} from '../sanitize-error.ts';
import type {LinearGraphQLClient} from './linear-provider.ts';
import type {TrackerIssue} from './types.ts';

const log = createLogger('linear-graphql');

const LINEAR_API_URL = 'https://api.linear.app/graphql';
const LINCTL_AUTH_PATH = path.join(os.homedir(), '.linctl-auth.json');
const REQUEST_TIMEOUT_MS = 15_000;

// Linear's GraphQL endpoint enforces a per-query complexity budget. Each
// aliased `issue` field with our selection set (state + project + labels)
// is cheap on its own but the budget bites in aggregate — a user with
// 30+ active worktrees risks a silent total-failure where every key
// short-circuits to CLI. We chunk well below the empirically-observed
// ceiling so a single oversized desk still gets the bulk speed-up; the
// outer Promise.all means batches still run concurrently.
export const BULK_BATCH_SIZE = 25;

// Selection set per aliased issue() field. Matches `parseLinearIssue` in
// linear-provider.ts so cached entries look identical regardless of source.
const ISSUE_FIELDS = `
	identifier
	title
	url
	state { name type color }
	project { name }
	labels(first: 50) { nodes { name } }
`;

// GraphQL aliases must be valid identifiers — STA-123 isn't one. We index
// instead and map back via the original issueKeys array.
function aliasFor(index: number): string {
	return `i${index}`;
}

/**
 * Resolve the Linear API key for the bulk GraphQL fetch.
 *
 * Precedence matches upstream linctl (v0.1.2+): `LINCTL_API_KEY` env var first,
 * then `~/.linctl-auth.json`. The env-var path is what lets pappardelle target
 * a non-default Linear workspace per-repo (e.g. a `.envrc` exports the wabo
 * workspace key in homebase while the global auth file still points at the
 * default workspace).
 */
export function resolveApiKey(
	env: NodeJS.ProcessEnv = process.env,
	authPath: string = LINCTL_AUTH_PATH,
): string | null {
	const envKey = env['LINCTL_API_KEY']?.trim();
	if (envKey) return envKey;

	try {
		const raw = fs.readFileSync(authPath, 'utf-8');
		const parsed = JSON.parse(raw) as {api_key?: unknown};
		if (typeof parsed.api_key === 'string' && parsed.api_key.length > 0) {
			return parsed.api_key;
		}

		return null;
	} catch {
		return null;
	}
}

type IssueResponseShape = {
	identifier?: string;
	title?: string;
	url?: string;
	state?: {name?: string; type?: string; color?: string};
	project?: {name?: string} | null;
	labels?: {nodes?: Array<{name?: string}>};
};

function parseGraphQLIssue(
	raw: IssueResponseShape | null,
): TrackerIssue | null {
	if (!raw || typeof raw.identifier !== 'string' || !raw.state) return null;
	const labelNodes = raw.labels?.nodes ?? [];
	return {
		identifier: raw.identifier,
		title: raw.title ?? '',
		state: {
			name: raw.state.name ?? '',
			type: raw.state.type ?? '',
			color: raw.state.color ?? '',
		},
		project: raw.project?.name ? {name: raw.project.name} : null,
		labels: labelNodes
			.map(n => n.name)
			.filter((name): name is string => typeof name === 'string'),
		...(typeof raw.url === 'string' && raw.url.length > 0
			? {url: raw.url}
			: {}),
	};
}

/** Injectable subset of `fetch` so tests can avoid real network. */
export type FetchLike = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
		signal: AbortSignal;
	},
) => Promise<{
	ok: boolean;
	status: number;
	text(): Promise<string>;
	json(): Promise<unknown>;
}>;

export interface LinearGraphQLClientOptions {
	apiKey: string;
	fetchImpl?: FetchLike;
	batchSize?: number;
	timeoutMs?: number;
}

async function fetchBatch(
	keys: readonly string[],
	apiKey: string,
	fetchImpl: FetchLike,
	timeoutMs: number,
): Promise<Map<string, TrackerIssue | null> | null> {
	const aliases = keys
		.map(
			(key, i) =>
				`${aliasFor(i)}: issue(id: ${JSON.stringify(key)}) {${ISSUE_FIELDS}}`,
		)
		.join('\n');
	const query = `query PappardelleBulkIssues {\n${aliases}\n}`;

	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, timeoutMs);

	try {
		const res = await fetchImpl(LINEAR_API_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: apiKey,
			},
			body: JSON.stringify({query}),
			signal: controller.signal,
		});

		if (!res.ok) {
			log.warn(
				`Linear GraphQL HTTP ${res.status} — falling back to CLI`,
				new Error(await res.text().catch(() => `status ${res.status}`)),
			);
			return null;
		}

		const parsed = (await res.json()) as {
			data?: Record<string, IssueResponseShape | null | undefined>;
			errors?: Array<{message: string}>;
		};

		if (parsed.errors?.length) {
			// Partial errors are normal (e.g. one issue archived); log but
			// keep whatever data Linear did return. The caller treats absent
			// keys as "fill from CLI", so partials don't need a hard fail.
			log.warn(
				'Partial GraphQL errors in bulk Linear fetch',
				new Error(parsed.errors.map(e => e.message).join('; ')),
			);
		}

		const result = new Map<string, TrackerIssue | null>();
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i]!;
			const raw = parsed.data?.[aliasFor(i)];
			result.set(key, parseGraphQLIssue(raw ?? null));
		}

		return result;
	} catch (err) {
		log.warn(
			'Linear GraphQL request failed — falling back to CLI',
			sanitizeSubprocessError(err),
		);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Build a LinearGraphQLClient from an explicit API key + (optionally) an
 * injectable fetch and batch size. The factory variant
 * `createDefaultLinearGraphQLClient()` reads the key from ~/.linctl-auth.json
 * and returns undefined when no key is available; this lower-level entry
 * point is what the unit tests exercise.
 */
export function makeLinearGraphQLClient(
	opts: LinearGraphQLClientOptions,
): LinearGraphQLClient {
	const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
	const batchSize = opts.batchSize ?? BULK_BATCH_SIZE;
	const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

	return async (issueKeys: readonly string[]) => {
		if (issueKeys.length === 0) return new Map();

		const batches: string[][] = [];
		for (let start = 0; start < issueKeys.length; start += batchSize) {
			batches.push(issueKeys.slice(start, start + batchSize));
		}

		// Total failure in any batch returns null — the caller's CLI fallback
		// then covers every requested key. We bias toward conservative fallback
		// over partial bulk wins to keep the error surface simple.
		const settled = await Promise.all(
			batches.map(async batch =>
				fetchBatch(batch, opts.apiKey, fetchImpl, timeoutMs),
			),
		);

		if (settled.some(b => b === null)) return null;

		const result = new Map<string, TrackerIssue | null>();
		for (const batch of settled) {
			if (batch) for (const [k, v] of batch) result.set(k, v);
		}

		return result;
	};
}

/**
 * Build the default LinearGraphQLClient. Returns undefined when no auth key
 * is available so the LinearProvider can skip wiring it up entirely and rely
 * on its CLI path. Callers that want test-time isolation should construct a
 * client directly via `makeLinearGraphQLClient` instead.
 */
export function createDefaultLinearGraphQLClient():
	| LinearGraphQLClient
	| undefined {
	const apiKey = resolveApiKey();
	if (!apiKey) {
		log.debug(
			`No LINCTL_API_KEY env var and no ${LINCTL_AUTH_PATH} — bulk Linear fetch disabled, will use linctl CLI.`,
		);
		return undefined;
	}

	return makeLinearGraphQLClient({apiKey});
}
