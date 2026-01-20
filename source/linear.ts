// Linear CLI utilities
import {execSync} from 'node:child_process';
import type {LinearIssue} from './types.js';
import {createLogger} from './logger.js';

const log = createLogger('linear');
const issueCache = new Map<string, LinearIssue | null>();

export async function getIssue(issueKey: string): Promise<LinearIssue | null> {
	// Check cache first
	if (issueCache.has(issueKey)) {
		return issueCache.get(issueKey) ?? null;
	}

	try {
		const output = execSync(`linctl issue get "${issueKey}" --json`, {
			encoding: 'utf-8',
			timeout: 10000,
		});
		const issue = JSON.parse(output) as LinearIssue;
		issueCache.set(issueKey, issue);
		log.debug(`Fetched issue ${issueKey}: ${issue.title}`);
		return issue;
	} catch (err) {
		log.warn(
			`Failed to fetch issue ${issueKey}`,
			err instanceof Error ? err : undefined,
		);
		issueCache.set(issueKey, null);
		return null;
	}
}

export function getIssueCached(issueKey: string): LinearIssue | null {
	return issueCache.get(issueKey) ?? null;
}

export function clearCache(): void {
	issueCache.clear();
}
