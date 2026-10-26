import React, {useEffect, useState} from 'react';
import {Box} from 'ink';
import type {LogEntry} from '../logger.ts';
import type {PopupActions, PopupSpec} from '../popup/spec.ts';
import AgentProfilePicker from './AgentProfilePicker.tsx';
import CloseSpaceDialog from './CloseSpaceDialog.tsx';
import ConfirmDialog from './ConfirmDialog.tsx';
import ErrorDialog from './ErrorDialog.tsx';
import HelpOverlay from './HelpOverlay.tsx';
import TextViewer from './TextViewer.tsx';

type Props = {
	spec: PopupSpec;
	actions: PopupActions;
	width: number;
	height: number;
};

/**
 * The dialog shown inside a tmux popup. It stays up until the TUI closes the
 * popup, which happens once the action an answer asked for has finished; that
 * is what keeps the close-space spinner on screen while the deinit hooks run.
 */
export default function PopupRoot({spec, actions, width, height}: Props) {
	const [errors, setErrors] = useState<LogEntry[]>(
		spec.kind === 'errors' ? spec.props.errors : [],
	);

	useEffect(() => actions.subscribeErrors?.(setErrors), [actions]);

	const renderDialog = () => {
		switch (spec.kind) {
			case 'confirm': {
				return (
					<ConfirmDialog
						isFullHeight
						{...spec.props}
						onConfirm={async () => actions.confirm()}
						onCancel={actions.cancel}
					/>
				);
			}

			case 'close-space': {
				return (
					<CloseSpaceDialog
						isFullHeight
						{...spec.props}
						onConfirm={async choice => actions.confirm({choice})}
						onCancel={actions.cancel}
					/>
				);
			}

			case 'help': {
				return (
					<HelpOverlay
						isFullHeight
						{...spec.props}
						availableHeight={height}
						onClose={actions.cancel}
					/>
				);
			}

			case 'errors': {
				return (
					<ErrorDialog
						isFullHeight
						errors={errors}
						onClose={actions.cancel}
						onClear={() => {
							void actions.clearErrors();
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
						onClose={actions.cancel}
					/>
				);
			}

			case 'agent-profile': {
				return (
					<AgentProfilePicker
						request={spec.props}
						availableHeight={height}
						onChoose={agentProfile => {
							void actions.confirm({agentProfile});
						}}
						onCancel={actions.cancel}
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
