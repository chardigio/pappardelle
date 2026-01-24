// Aerospace workspace listing
import {execSync} from 'node:child_process';
import {createLogger} from './logger.js';

const log = createLogger('aerospace');

interface AerospaceWorkspace {
	workspace: string;
}

// Cache aerospace availability to avoid repeated timeout checks
let aerospaceAvailable: boolean | null = null;

/**
 * Check if aerospace is available (has GUI access).
 * Only checks once per process lifetime.
 */
function isAerospaceAvailable(): boolean {
	if (aerospaceAvailable !== null) {
		return aerospaceAvailable;
	}

	// No GUI available over SSH or in headless sessions
	if (!process.env['DISPLAY'] && !process.env['__CFBundleIdentifier']) {
		// On macOS, check if we can reach the window server
		try {
			// Quick check with very short timeout
			execSync('aerospace list-workspaces --all --json 2>/dev/null', {
				encoding: 'utf-8',
				timeout: 500, // 500ms should be enough if aerospace is responsive
			});
			aerospaceAvailable = true;
			log.info('Aerospace is available');
		} catch {
			aerospaceAvailable = false;
			log.warn('Aerospace not available (likely headless/SSH session)');
		}
	} else {
		// Has display, assume aerospace is available but verify
		try {
			execSync('aerospace list-workspaces --all --json 2>/dev/null', {
				encoding: 'utf-8',
				timeout: 500,
			});
			aerospaceAvailable = true;
			log.info('Aerospace is available');
		} catch {
			aerospaceAvailable = false;
			log.warn('Aerospace not available');
		}
	}

	return aerospaceAvailable;
}

/**
 * List all Aerospace workspaces (all monitors)
 */
export function listWorkspaces(): string[] {
	// Skip if aerospace is not available (headless/SSH)
	if (!isAerospaceAvailable()) {
		return [];
	}

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
