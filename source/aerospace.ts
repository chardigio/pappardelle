// Aerospace workspace listing
import {execSync} from 'node:child_process';
import {createLogger} from './logger.js';

const log = createLogger('aerospace');

interface AerospaceWorkspace {
	workspace: string;
}

/**
 * List all Aerospace workspaces (all monitors)
 */
export function listWorkspaces(): string[] {
	try {
		const output = execSync(
			'aerospace list-workspaces --all --json 2>/dev/null',
			{
				encoding: 'utf-8',
				timeout: 5000,
			},
		);
		const workspaces: AerospaceWorkspace[] = JSON.parse(output);
		log.debug(`Found ${workspaces.length} workspaces`);
		return workspaces.map(w => w.workspace);
	} catch (err) {
		log.error(
			'Failed to list workspaces',
			err instanceof Error ? err : undefined,
		);
		return [];
	}
}

/**
 * Check if workspace name looks like a Linear issue key
 */
export function isLinearIssueWorkspace(workspaceName: string): boolean {
	return /^[A-Z]+-\d+$/.test(workspaceName);
}

/**
 * Get all Linear issue workspaces
 */
export function getLinearWorkspaces(): string[] {
	return listWorkspaces().filter(isLinearIssueWorkspace);
}
