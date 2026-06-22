import type {UpdateInfo} from './update-check.ts';

// ============================================================================
// Update keybinding decision
// ============================================================================

export type UpdateKeyAction = 'open-confirm' | 'dismiss-banner' | 'none';

// Decide what an update-related keystroke means in the list-view input handler.
//
// Pressing `U` is ALWAYS an explicit "update to the latest release" request —
// even when no banner is showing. The startup update-check is cached for 24h,
// so a release that landed a few minutes ago wouldn't have surfaced a banner
// yet; gating U on a visible banner would make it impossible to pull that
// release without restarting and waiting out the cache (STA-1548). Both U paths
// (banner-present and banner-absent) funnel through the same confirm dialog.
//
// `X` only means "dismiss" while the banner is actually on screen — there's
// nothing to dismiss otherwise.
export function resolveUpdateKeyAction(
	input: string,
	bannerVisible: boolean,
): UpdateKeyAction {
	if (input === 'U' || input === 'u') return 'open-confirm';
	if (bannerVisible && (input === 'X' || input === 'x'))
		return 'dismiss-banner';
	return 'none';
}

// ============================================================================
// Confirm dialog copy
// ============================================================================

export type UpdateConfirmContent = {
	title: string;
	message: string;
	detail: string;
};

const UPDATE_DETAIL =
	'Downloads and runs the installer, then restarts Pappardelle.';

function tag(version: string): string {
	return `v${version.replace(/^[vV]/, '')}`;
}

// Build the copy for the "are you sure?" dialog (STA-1548). When the startup
// check already surfaced a concrete installed→latest delta (the banner path) we
// show both versions. Otherwise — the always-available U press, where the cache
// is fresh enough that we have no fetched "latest" to compare against — we fall
// back to the version we're currently running, or to a bare prompt when even
// that is unknown (a fresh install before any release tag is reachable).
export function buildUpdateConfirmContent(
	updateInfo: UpdateInfo | null,
	installedVersion: string | null,
): UpdateConfirmContent {
	const title = 'Update Pappardelle';
	if (updateInfo) {
		return {
			title,
			message: `Update from ${tag(updateInfo.installedVersion)} to ${tag(
				updateInfo.latestVersion,
			)}?`,
			detail: UPDATE_DETAIL,
		};
	}

	if (installedVersion) {
		return {
			title,
			message: `Update to the latest release? (currently on ${tag(
				installedVersion,
			)})`,
			detail: UPDATE_DETAIL,
		};
	}

	return {
		title,
		message: 'Update to the latest release?',
		detail: UPDATE_DETAIL,
	};
}
