import type {LatestTask} from './latest-task.ts';

export type SendToClaudeResult = 'sent' | 'wrong-space' | 'failed';

/**
 * Attachment is async, so the Claude viewer can still show the previous
 * workspace when a send key arrives. Keys such as /merge-and-monitor-when-green
 * or /clear must never reach that agent, so the send waits behind any running
 * attachment and then goes only to the workspace the user selected.
 */
export async function sendToSelectedClaude(options: {
	queue: Pick<LatestTask, 'exclusive'>;
	targetSpace: string;
	viewingSpace: () => string | null;
	send: () => boolean;
}): Promise<SendToClaudeResult> {
	return options.queue.exclusive(async () => {
		if (options.viewingSpace() !== options.targetSpace) return 'wrong-space';
		return options.send() ? 'sent' : 'failed';
	});
}
