import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateConfig} from '../../source/config-validation.ts';

export function setupTempDir(files: Record<string, string>): {
	dir: string;
	cleanup: () => void;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-merge-'));
	for (const [name, content] of Object.entries(files)) {
		const filePath = path.join(dir, name);
		fs.mkdirSync(path.dirname(filePath), {recursive: true});
		fs.writeFileSync(filePath, content, 'utf-8');
	}

	return {
		dir,
		cleanup() {
			fs.rmSync(dir, {recursive: true, force: true});
		},
	};
}

// eslint-disable-next-line no-template-curly-in-string -- a shell template, expanded by bash, not JS
export const CODE_IDE_COMMAND = 'code "${WORKTREE_PATH}"';

export function validateListView(listView: Record<string, unknown>): string {
	try {
		validateConfig({
			version: 1,
			profiles: {test: {display_name: 'Test'}},
			list_view: listView,
		});
		return '';
	} catch (error) {
		return (error as Error).message;
	}
}
