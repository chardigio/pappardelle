// tmux user options on a viewer pane, shared by the rail and the frame host
// running in that pane.

/** The frame's title until the nested session names itself. */
export const PANE_TITLE_OPTION = '@pappardelle_title';

/** The tty of the nested tmux client running inside the frame. */
export const CLIENT_TTY_OPTION = '@pappardelle_client_tty';
