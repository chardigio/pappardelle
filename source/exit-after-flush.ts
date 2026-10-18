/**
 * Exit once everything already written to stdout has gone out. On macOS a
 * pipe to stdout is asynchronous, so a bare process.exit after a large write
 * cuts the output off, and an agent piping JSON into jq gets half of it.
 */
export async function exitAfterFlush(code: number): Promise<never> {
	await new Promise<void>(resolve => {
		process.stdout.write('', () => {
			resolve();
		});
	});
	// eslint-disable-next-line unicorn/no-process-exit
	process.exit(code);
}
