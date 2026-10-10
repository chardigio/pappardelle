import React, {useEffect, useState} from 'react';
import {Box} from 'ink';
import type {LogEntry} from '../logger.ts';
import type {ChildMessage, HostMessage, PopupSpec} from '../popup/protocol.ts';
import ConfirmDialog from './ConfirmDialog.tsx';
import ErrorDialog from './ErrorDialog.tsx';
import HelpOverlay from './HelpOverlay.tsx';
import TextViewer from './TextViewer.tsx';

export type PopupChannel = {
	send(message: ChildMessage): void;
	onMessage(listener: (message: HostMessage) => void): () => void;
};

type Props = {
	spec: PopupSpec;
	channel: PopupChannel;
	width: number;
	height: number;
	onExit: () => void;
};

/**
 * The dialog shown inside a tmux popup. Answers go to the TUI over `channel`;
 * the popup stays up until the TUI replies `done`, which is what keeps the
 * close-space spinner on screen while the deinit hooks run.
 */
export default function PopupRoot({
	spec,
	channel,
	width,
	height,
	onExit,
}: Props) {
	const [errors, setErrors] = useState<LogEntry[]>(
		spec.kind === 'errors' ? spec.props.errors : [],
	);

	useEffect(
		() =>
			channel.onMessage(message => {
				if (message.type === 'done') onExit();
				else if (message.type === 'errors') setErrors(message.errors);
			}),
		[channel, onExit],
	);

	const cancel = () => {
		channel.send({type: 'cancel'});
		onExit();
	};

	const renderDialog = () => {
		switch (spec.kind) {
			case 'confirm': {
				return (
					<ConfirmDialog
						isFullHeight
						{...spec.props}
						onConfirm={async () =>
							new Promise<void>(() => {
								// Never resolves: the TUI's `done` exits the popup.
								channel.send({type: 'confirm'});
							})
						}
						onCancel={cancel}
					/>
				);
			}

			case 'help': {
				return <HelpOverlay isFullHeight {...spec.props} onClose={cancel} />;
			}

			case 'errors': {
				return (
					<ErrorDialog
						isFullHeight
						errors={errors}
						onClose={cancel}
						onClear={() => {
							channel.send({type: 'clear-errors'});
						}}
					/>
				);
			}

			case 'issue': {
				return (
					<TextViewer
						argv={spec.props.argv}
						title={spec.props.title}
						width={width}
						height={height}
						onClose={cancel}
					/>
				);
			}
		}
	};

	return (
		<Box flexDirection="column" width={width} height={height}>
			{renderDialog()}
		</Box>
	);
}
