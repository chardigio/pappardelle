// Linear CLI utilities - uses caching to avoid rate limiting
import {execSync} from 'node:child_process';
import type {LinearIssue} from './types.js';
import {createLogger} from './logger.js';

const log = createLogger('linear');
const CACHE_TTL_MS = 60000; // 60 seconds (to avoid rate limiting)

interface CacheEntry {
	issue: LinearIssue | null;
	timestamp: number;
}

const issueCache = new Map<string, CacheEntry>();

// Persistent map of state name → color, populated as issues are fetched.
// Persists even after issue cache entries expire, so workflow colors are always available.
const stateColorMap = new Map<string, string>();

export async function getIssue(issueKey: string): Promise<LinearIssue | null> {
	// Check cache first (with TTL)
	const cached = issueCache.get(issueKey);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		// Ensure state color map is populated even on cache hits
		if (cached.issue) {
			stateColorMap.set(cached.issue.state.name, cached.issue.state.color);
		}

		return cached.issue;
	}

	try {
		const output = execSync(`linctl issue get "${issueKey}" --json`, {
			encoding: 'utf-8',
			timeout: 10000,
		});
		const issue = JSON.parse(output) as LinearIssue;
		issueCache.set(issueKey, {issue, timestamp: Date.now()});
		stateColorMap.set(issue.state.name, issue.state.color);
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

/**
 * Look up a workflow state color. First checks the in-memory map (populated
 * as issues are fetched). If not found, fetches one issue in that state from
 * Linear to discover the color. This handles states like "Done" that may
 * never appear in active workspaces.
 */
export function getWorkflowStateColor(stateName: string): string | null {
	const cached = stateColorMap.get(stateName);
	if (cached) return cached;

	// Fetch one issue in this state to discover its color
	try {
		const output = execSync(
			`linctl issue list --state "${stateName}" --limit 1 --json`,
			{encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe']},
		);
		const issues = JSON.parse(output) as LinearIssue[];
		if (issues.length > 0 && issues[0]!.state.color) {
			stateColorMap.set(stateName, issues[0]!.state.color);
			return issues[0]!.state.color;
		}
	} catch {
		log.warn(`Failed to fetch workflow state color for "${stateName}"`);
	}

	return null;
}

export function clearCache(): void {
	issueCache.clear();
}
