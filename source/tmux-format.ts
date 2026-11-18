// tmux expands formats in new-session's -s, in set-titles-string and in
// pipe-pane's command, so a repo named `pasta#S` would otherwise be stored or
// shown as something else.
export function tmuxFormatLiteral(text: string): string {
	return text.replaceAll('#', '##');
}
