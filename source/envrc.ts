import fs from 'node:fs';
import path from 'node:path';
import {createLogger} from './logger.ts';

const log = createLogger('envrc');

/**
 * Parse a minimal subset of direnv's .envrc — only plain
 * `export KEY=VALUE` lines, with optional surrounding single or double quotes
 * on the value. Lines that aren't `export KEY=VALUE` are ignored (so things
 * like direnv stdlib calls — `dotenv`, `use node`, `source_up` — are simply
 * skipped instead of breaking pappardelle).
 *
 * Returning a plain map (not mutating process.env) keeps this pure and lets
 * the loader decide whether to overwrite existing vars.
 */
export function parseEnvrc(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const rawLine of content.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;

		const match = /^export\s+([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
		if (!match) continue;

		const key = match[1]!;
		let value = match[2]!.trim();

		// Strip a trailing inline comment when the value isn't quoted.
		// Quoted values can legitimately contain '#' so we only strip in the
		// unquoted case.
		const quoted = /^(['"])(.*)\1$/.exec(value);
		if (quoted) {
			value = quoted[2]!;
		} else {
			const hashIndex = value.indexOf(' #');
			if (hashIndex !== -1) value = value.slice(0, hashIndex).trim();
		}

		result[key] = value;
	}

	return result;
}

/**
 * Read $repoRoot/.envrc and apply its plain `export KEY=VALUE` lines into
 * process.env. No-op when the file doesn't exist.
 *
 * Vars already set in process.env are NOT overwritten — explicit env beats
 * the on-disk file. This matches direnv's general behavior of layering on top
 * of the inherited environment for the duration of the shell.
 */
export function loadEnvrcIntoProcessEnv(
	repoRoot: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const envrcPath = path.join(repoRoot, '.envrc');
	let content: string;
	try {
		content = fs.readFileSync(envrcPath, 'utf-8');
	} catch (e: unknown) {
		// ENOENT is the expected no-.envrc case — silent. Anything else (EACCES
		// after a chmod, EISDIR, EMFILE, etc.) gets logged so a stuck-Loading
		// regression is traceable instead of silently falling back to disk creds.
		if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
			log.debug(`Failed to read ${envrcPath}: ${String(e)}`);
		}
		return;
	}

	const parsed = parseEnvrc(content);
	let applied = 0;
	for (const [key, value] of Object.entries(parsed)) {
		if (env[key] !== undefined) continue;
		env[key] = value;
		applied++;
	}

	if (applied > 0) {
		log.debug(`Loaded ${applied} env var(s) from ${envrcPath}`);
	}
}
