import type {AgentProfileRequest} from '../agent-profile-picker.ts';
import type {KeybindingConfig} from '../config.ts';
import type {StateChoice} from '../close-state-choice.ts';
import type {LogEntry} from '../logger.ts';
import type {TrackerIssue} from '../providers/types.ts';

export type ConfirmPopupProps = {
	title: string;
	message: string;
	detail?: string;
	processingMessage?: string;
};

export type CloseSpacePopupProps = {
	spaceName: string;
	currentIssue: TrackerIssue | null;
};

export type HelpPopupProps = {
	customKeybindings: KeybindingConfig[];
	commitSha: string;
	installedVersion?: string | null;
	isDevBuild?: boolean;
};

export type ErrorsPopupProps = {errors: LogEntry[]};

export type IssuePopupProps = {argv: string[]; title: string};

export type PopupSpec =
	| {kind: 'confirm'; props: ConfirmPopupProps}
	| {kind: 'close-space'; props: CloseSpacePopupProps}
	| {kind: 'help'; props: HelpPopupProps}
	| {kind: 'errors'; props: ErrorsPopupProps}
	| {kind: 'issue'; props: IssuePopupProps}
	| {kind: 'agent-profile'; props: AgentProfileRequest};

export type PopupKind = PopupSpec['kind'];

export type ConfirmPayload = {choice?: StateChoice; agentProfile?: string};

/** What a dialog in a popup can ask of the TUI. */
export type PopupActions = {
	/** Resolves once the TUI has finished what the answer asked for. */
	confirm: (payload?: ConfirmPayload) => Promise<void>;
	cancel: () => void;
	clearErrors: () => Promise<void>;
	subscribeErrors?: (push: (errors: LogEntry[]) => void) => () => void;
};
