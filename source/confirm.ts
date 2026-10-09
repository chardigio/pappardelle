import {createInterface} from 'node:readline/promises';
import type {Readable, Writable} from 'node:stream';

// Ctrl+D or a closed stdin at a y/N prompt means "no", not a crash.
export async function confirm(
	question: string,
	input: Readable = process.stdin,
	output: Writable = process.stdout,
): Promise<boolean> {
	const rl = createInterface({input, output});
	const closed = new Promise<string>(resolve => {
		rl.once('close', () => {
			resolve('');
		});
	});
	try {
		const answer = await Promise.race([rl.question(question), closed]);
		return /^y(es)?$/i.test(answer.trim());
	} catch {
		return false;
	} finally {
		rl.close();
	}
}
