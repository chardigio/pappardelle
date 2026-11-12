// `--internal-state <verb>`: state changes that bash asks the binary to make,
// so that scripts never write state files or SQL themselves.

import {openStateDb} from './state-db.ts';

type Verb = (args: string[]) => number | Promise<number>;

function usage(message: string): number {
	console.error(`pappardelle --internal-state: ${message}`);
	return 2;
}

const verbs: Record<string, Verb> = {
	/** Create or upgrade the database at a path, for the hooks' tests. */
	migrate([dbPath]) {
		if (!dbPath) return usage('migrate needs a database path');
		openStateDb(dbPath);
		return 0;
	},
};

const [name, ...args] = process.argv.slice(2);
const verb = name ? verbs[name] : undefined;
try {
	process.exitCode = verb
		? await verb(args)
		: usage(name ? `unknown verb ${name}` : 'missing verb');
} catch (error) {
	console.error(
		`pappardelle --internal-state ${name}: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
}
