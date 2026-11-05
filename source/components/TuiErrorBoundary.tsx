import {Component, type ReactNode} from 'react';
import {useKeyboard, useRenderer} from '@opentui/react';
import {terminalColor} from '../tui-style.ts';

function FailedView({message}: {message: string}) {
	const renderer = useRenderer();
	useKeyboard(key => {
		if (key.name === 'q' || key.name === 'escape') renderer.destroy();
	});
	return (
		<box flexDirection="column" padding={1}>
			<text fg={terminalColor('red')}>Unable to render this view</text>
			<text fg={terminalColor()}>{message}</text>
			<text fg={terminalColor('gray')}>Press q or Esc to close.</text>
		</box>
	);
}

/** Keep render failures visible and dismissible, including in popup terminals. */
export default class TuiErrorBoundary extends Component<
	{children?: ReactNode},
	{message?: string}
> {
	override state: {message?: string} = {};

	static getDerivedStateFromError(error: unknown) {
		return {message: error instanceof Error ? error.message : String(error)};
	}

	override componentDidCatch(error: Error) {
		// The CLI's stderr capture records the stack for the existing error log.
		console.error(error);
	}

	override render() {
		return this.state.message === undefined ? (
			this.props.children
		) : (
			<FailedView message={this.state.message} />
		);
	}
}
