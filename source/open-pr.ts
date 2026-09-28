import type {VcsHostProvider} from './providers/types.ts';

export async function openPR(
	issueKey: string,
	options: {
		provider: Pick<VcsHostProvider, 'getPRLink'>;
		isCurrent: () => boolean;
		openUrl: (url: string) => Promise<void>;
		showMessage: (message: string) => void;
	},
): Promise<void> {
	let pr;
	try {
		pr = await options.provider.getPRLink(issueKey);
	} catch {
		if (options.isCurrent()) options.showMessage('Failed to look up PR');
		return;
	}

	if (!options.isCurrent()) return;
	if (!pr) {
		options.showMessage(`No PR found for ${issueKey}`);
		return;
	}

	try {
		await options.openUrl(pr.url);
		if (options.isCurrent()) options.showMessage(`Opened PR #${pr.number}`);
	} catch {
		if (options.isCurrent()) options.showMessage('Could not launch open');
	}
}
