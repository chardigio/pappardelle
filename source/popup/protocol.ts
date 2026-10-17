import type {Buffer} from 'node:buffer';
import type {KeybindingConfig} from '../config.ts';
import type {LogEntry} from '../logger.ts';

export type ConfirmPopupProps = {
	title: string;
	message: string;
	detail?: string;
	processingMessage?: string;
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
	| {kind: 'help'; props: HelpPopupProps}
	| {kind: 'errors'; props: ErrorsPopupProps}
	| {kind: 'issue'; props: IssuePopupProps};

export type PopupKind = PopupSpec['kind'];

export type HostMessage =
	| ({type: 'init'; env: Record<string, string>; cwd: string} & PopupSpec)
	| {type: 'done'}
	| {type: 'errors'; errors: LogEntry[]};

export type ChildMessage =
	| {type: 'confirm'}
	| {type: 'cancel'}
	| {type: 'clear-errors'};

export function encodeMessage(message: HostMessage | ChildMessage): string {
	return `${JSON.stringify(message)}\n`;
}

/**
 * Split a byte stream into newline-delimited JSON messages. A socket hands
 * over whatever arrived, so one chunk can end mid-message and the rest shows
 * up in the next one.
 */
export function createMessageDecoder<T extends {type: string}>(
	onMessage: (message: T) => void,
): (chunk: Buffer | string) => void {
	let buffered = '';
	return chunk => {
		buffered += chunk.toString();
		let newline = buffered.indexOf('\n');
		while (newline !== -1) {
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			newline = buffered.indexOf('\n');
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}

			if (
				parsed !== null &&
				typeof parsed === 'object' &&
				typeof (parsed as {type?: unknown}).type === 'string'
			) {
				onMessage(parsed as T);
			}
		}
	};
}
