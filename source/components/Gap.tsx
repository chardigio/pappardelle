/**
 * A blank row between dialog sections. Unlike a margin it can shrink, so a
 * dialog in a short tmux popup gives up its spacing before its text.
 */
export default function Gap() {
	return <box height={1} flexShrink={1} />;
}
