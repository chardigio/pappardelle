import {Component, type ErrorInfo, type ReactNode} from 'react';
import {useKeyboard, useRenderer} from '@opentui/react';
import {createLogger} from '../logger.ts';
import {terminalColor, textAttributes} from '../tui-style.ts';

const log = createLogger('tui');

function FailedView({
	message,
	onClose,
}: {
	message: string;
	onClose?: () => void;
}) {
	const renderer = useRenderer();
	useKeyboard(key => {
		if (key.name !== 'q' && key.name !== 'escape') return;
		if (onClose) onClose();
		else renderer.destroy();
	});
	return (
		<box flexDirection="column" padding={1}>
			<text fg={terminalColor('red')}>Unable to render this view</text>
			<text fg={terminalColor()}>{message}</text>
			<text fg={terminalColor()} attributes={textAttributes({dim: true})}>
				Press q or Esc to close.
			</text>
		</box>
	);
}

/**
 * Keep render failures visible and dismissible, including in popup terminals.
 * `onClose` replaces the plain renderer teardown, so the rail can also close
 * its layout as q does.
 */
export default class TuiErrorBoundary extends Component<
	{children?: ReactNode; onClose?: () => void},
	{message?: string}
> {
	override state: {message?: string} = {};

	static getDerivedStateFromError(error: unknown) {
		return {message: error instanceof Error ? error.message : String(error)};
	}

	override componentDidCatch(error: Error, info: ErrorInfo) {
		// The logger retains only error.message, so include the stack explicitly.
		// React's own report, which carries the component stack, is dropped by the
		// console redirect so the failure counts once.
		log.error(
			`${error.stack ?? error.message}\n\nComponent stack:${info.componentStack ?? ''}`,
			error,
		);
	}

	override render() {
		return this.state.message === undefined ? (
			this.props.children
		) : (
			<FailedView message={this.state.message} onClose={this.props.onClose} />
		);
	}
}
