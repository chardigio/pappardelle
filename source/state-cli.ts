// `--internal-state <verb>`: state changes that bash asks the binary to make,
// so that scripts never write state files or SQL themselves.

import {parseArgs} from 'node:util';
import {createStateDaos} from './state-daos.ts';
import {openStateDb} from './state-db.ts';

type Verb = (args: string[]) => number | Promise<number>;

function usage(message: string): number {
	console.error(`pappardelle --internal-state: ${message}`);
	return 2;
}

const verbs: Record<string, Verb> = {
	/**
	 * What idow records about a space before it starts the space's sessions.
	 * `--register --owner <pid>` holds the space for the process setting it up.
	 */
	async 'prepare-space'(args) {
		const {values, positionals} = parseArgs({
			args,
			allowPositionals: true,
			options: {
				repo: {type: 'string'},
				register: {type: 'boolean'},
				owner: {type: 'string'},
			},
		});
		const [key] = positionals;
		if (!values.repo || !key || positionals.length !== 1)
			return usage('prepare-space needs --repo <name> and one space key');
		const daos = createStateDaos({repo: values.repo});
		if (values.register) {
			const owner = Number(values.owner);
			if (!Number.isInteger(owner) || owner <= 0)
				return usage('--register needs --owner <pid>');
			await daos.registry.reserveStart(key, owner);
		}

		return 0;
	},

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
