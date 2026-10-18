import {mkdirSync, readFileSync, watch} from 'node:fs';
import path from 'node:path';

/**
 * Call `callback` with the trimmed content of `filePath` each time it is
 * written. The directory is watched rather than the file, so writes that
 * replace the file by rename are seen too.
 */
export function watchFileContent(
	filePath: string,
	callback: (content: string) => void,
): () => void {
	const dir = path.dirname(filePath);
	const filename = path.basename(filePath);

	mkdirSync(dir, {recursive: true});

	const watcher = watch(dir, (_eventType, changedFile) => {
		if (changedFile !== filename) return;
		try {
			const content = readFileSync(filePath, 'utf-8').trim();
			if (content) {
				callback(content);
			}
		} catch {
			// File may have been deleted between event and read
		}
	});

	return () => watcher.close();
}
