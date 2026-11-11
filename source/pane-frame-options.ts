// tmux user options on a viewer pane, shared by the rail and the frame host
// running in that pane.

/** The frame's title until the nested session names itself. */
export const PANE_TITLE_OPTION = '@pappardelle_title';

/** The tty of the nested tmux client running inside the frame. */
export const CLIENT_TTY_OPTION = '@pappardelle_client_tty';

/** What a frame started ahead of its program runs once the rail signals it. */
export const FRAME_COMMAND_OPTION = '@pappardelle_frame_command';

/** The wait-for channel a frame started ahead of its program listens on. */
export function frameReadyChannel(paneId: string): string {
	return `pappardelle-frame-ready-${paneId}`;
}

/**
 * The wait-for channel a frame's child signals as it publishes its tty, just
 * before it runs its program.
 */
export function frameStartedChannel(paneId: string): string {
	return `pappardelle-frame-started-${paneId}`;
}
