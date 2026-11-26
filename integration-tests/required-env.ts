/** The variable's value; without one, prints how to set it and exits 1. */
export function requiredEnv(name: string, example: string): string {
	const value = process.env[name];
	if (value) return value;
	console.error(`\u274C ${name} is required. Example:\n  ${example}`);
	// eslint-disable-next-line unicorn/no-process-exit -- only the verify scripts, which are CLIs, import it
	process.exit(1);
}
