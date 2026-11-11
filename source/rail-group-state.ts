import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {createLogger} from './logger.ts';

const log = createLogger('rail-group-state');

const DEFAULT_BASE_DIR = path.join(homedir(), '.pappardelle');

export function getRailGroupStatePath(
	repoName: string,
	baseDir?: string,
): string {
	return path.join(
		baseDir ?? DEFAULT_BASE_DIR,
		'repos',
		repoName,
		'rail-groups.json',
	);
}

/**
 * The groups the user left collapsed, limited to `knownIds` so a group that
 * was renamed or removed from `list_view.groups` doesn't linger in the file.
 * A missing or unreadable file means every group starts expanded.
 */
export function readCollapsedGroups(
	repoName: string,
	knownIds: readonly string[],
	baseDir?: string,
): Set<string> {
	const file = getRailGroupStatePath(repoName, baseDir);
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return new Set();
	}

	try {
		const parsed: unknown = JSON.parse(text);
		const collapsed =
			parsed && typeof parsed === 'object'
				? (parsed as Record<string, unknown>)['collapsed']
				: undefined;
		if (!Array.isArray(collapsed)) return new Set();
		return new Set(
			collapsed.filter(
				(id): id is string => typeof id === 'string' && knownIds.includes(id),
			),
		);
	} catch (error) {
		log.warn(`Ignoring unreadable ${file}`, error as Error);
		return new Set();
	}
}

export function writeCollapsedGroups(
	repoName: string,
	collapsed: ReadonlySet<string>,
	baseDir?: string,
): void {
	const file = getRailGroupStatePath(repoName, baseDir);
	try {
		fs.mkdirSync(path.dirname(file), {recursive: true});
		fs.writeFileSync(
			file,
			JSON.stringify({collapsed: [...collapsed].sort()}, null, 2) + '\n',
		);
	} catch (error) {
		log.warn(`Could not save collapsed rail groups to ${file}`, error as Error);
	}
}
