/**
 * Exit once everything already written to stdout has gone out. A pipe to
 * stdout can be asynchronous, so a bare process.exit after a large write cuts
 * the output off when the reader is slow, and an agent piping JSON into jq
 * gets half of it. Under Bun neither a write's callback nor the stream's
 * buffered length says the bytes have left; ending the stream does.
 */
export async function exitAfterFlush(code: number): Promise<never> {
	await new Promise<void>(resolve => {
		process.stdout.end(resolve);
	});
	// eslint-disable-next-line unicorn/no-process-exit
	process.exit(code);
}
