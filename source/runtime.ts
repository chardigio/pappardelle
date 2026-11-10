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
// Bun otherwise loads .env and bunfig.toml (including preload scripts) from
// the working directory, which is usually a user's workspace. The compiled
// executable disables both at build time.
export const bunIsolationArgs = ['--no-env-file', '--config=/dev/null'];
export function selfLaunchArgs(): string[] {
	return isStandalone ? [] : [...bunIsolationArgs, cliFilePath()];
}
// The Bun running a source install, handed to child scripts whose PATH (the
// tmux server's, or a shell's behind the pinned shim) may not contain it. The
// compiled executable needs no Bun.
export function bunForChildren(): string | undefined {
	return isStandalone ? undefined : process.execPath;
}
