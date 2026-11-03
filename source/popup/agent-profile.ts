import type {AgentProfileRequest} from '../agent-profile-picker.ts';
import {openPopup} from './host.ts';

/**
 * Open the agent profile list in a tmux popup over the TUI and resolve with
 * the chosen name, or null when it was dismissed or tmux isn't there to show
 * it.
 */
export async function pickAgentProfileInPopup(
	request: AgentProfileRequest,
): Promise<string | null> {
	if (request.options.length === 0) return null;
	let chosen: string | null = null;
	await openPopup(
		{kind: 'agent-profile', props: request},
		{
			onConfirm(payload) {
				chosen = payload?.agentProfile ?? null;
			},
		},
	);
	return chosen;
}
