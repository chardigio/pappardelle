import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

declare const PAPPARDELLE_COMPILED: boolean;
export const isStandalone =
	// eslint-disable-next-line unicorn/no-typeof-undefined -- Absent in source/dev execution.
	typeof PAPPARDELLE_COMPILED !== 'undefined' && PAPPARDELLE_COMPILED;

// Both the executable and JavaScript entry points live in <install>/dist.
// Compiled import.meta URLs live in Bun's virtual filesystem, not the install.
export const installationRoot = path.resolve(
	isStandalone
		? path.dirname(process.execPath)
		: path.dirname(fileURLToPath(import.meta.url)),
	'..',
);
export const scriptsDir = path.join(installationRoot, 'scripts');
export const packageModuleUrl = pathToFileURL(
	path.join(installationRoot, 'dist/cli.js'),
).href;
export function cliFilePath(): string {
	return isStandalone ? process.execPath : path.resolve(process.argv[1] ?? '');
}
export function selfLaunchArgs(): string[] {
	return isStandalone ? [] : [cliFilePath()];
}
