// Linear CLI utilities
import {execSync} from 'node:child_process';
import type {LinearIssue} from './types.js';
import {createLogger} from './logger.js';

const log = createLogger('linear');
const CACHE_TTL_MS = 5000; // 5 seconds

interface CacheEntry {
	issue: LinearIssue | null;
	timestamp: number;
}

const issueCache = new Map<string, CacheEntry>();

export async function getIssue(issueKey: string): Promise<LinearIssue | null> {
	// Check cache first (with TTL)
	const cached = issueCache.get(issueKey);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		return cached.issue;
	}

	try {
		const output = execSync(`linctl issue get "${issueKey}" --json`, {
			encoding: 'utf-8',
			timeout: 10000,
		});
		const issue = JSON.parse(output) as LinearIssue;
		issueCache.set(issueKey, {issue, timestamp: Date.now()});
		log.debug(`Fetched issue ${issueKey}: ${issue.title}`);
		return issue;
	} catch (err) {
		log.warn(
			`Failed to fetch issue ${issueKey}`,
			err instanceof Error ? err : undefined,
		);
		issueCache.set(issueKey, {issue: null, timestamp: Date.now()});
		return null;
	}
}

export function getIssueCached(issueKey: string): LinearIssue | null {
	return issueCache.get(issueKey)?.issue ?? null;
}

export function clearCache(): void {
	issueCache.clear();
}
