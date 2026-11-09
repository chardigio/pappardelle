import type {LatestTask} from './latest-task.ts';
import type {SendToSpaceAgentResult} from './tmux.ts';

export type SendToClaudeResult = SendToSpaceAgentResult | 'wrong-space';

/**
 * Attachment is async, so the Claude viewer can still show the previous
 * workspace when a send key arrives. Keys such as /merge-and-monitor-when-green
 * or /clear must never reach that agent, so the send waits behind any running
 * attachment and then goes only to the workspace the user selected.
 * A send can wait up to the send lock's timeout behind another sender, so it
 * runs on its own queue rather than holding up attachment for that long.
 */
export async function sendToSelectedAgent(options: {
	queue: Pick<LatestTask, 'exclusive'>;
	sends: Pick<LatestTask, 'exclusive'>;
	targetSpace: string;
	viewingSpace: () => string | null;
	send: () => Promise<SendToSpaceAgentResult>;
}): Promise<SendToClaudeResult> {
	const queued = await options.queue.exclusive(async () =>
		options.viewingSpace() === options.targetSpace
			? {sending: options.sends.exclusive(options.send)}
			: undefined,
	);
	if (!queued) return 'wrong-space';
	return queued.sending;
}
