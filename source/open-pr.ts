import type {VcsHostProvider} from './providers/types.ts';

export async function openPR(
	issueKey: string,
	options: {
		provider: Pick<VcsHostProvider, 'getPRLink'>;
		/**
		 * A PR recorded by `pappardelle link-pr`, which can live on another
		 * branch or in a nested repo the issue-key lookup never searches.
		 */
		linked?: {url: string; number: number};
		/** False once a newer open-PR request has started. */
		isLatest: () => boolean;
		/** False once any newer header message has been shown. */
		ownsHeader: () => boolean;
		openUrl: (url: string) => Promise<void>;
		showMessage: (message: string) => void;
	},
): Promise<void> {
	const report = (message: string) => {
		if (options.isLatest() && options.ownsHeader())
			options.showMessage(message);
	};

	let pr = options.linked;
	if (!pr) {
		try {
			pr = (await options.provider.getPRLink(issueKey)) ?? undefined;
		} catch {
			report('Failed to look up PR');
			return;
		}
	}

	if (!options.isLatest()) return;
	if (!pr) {
		report(`No PR found for ${issueKey}`);
		return;
	}

	try {
		await options.openUrl(pr.url);
		report(`Opened PR #${pr.number}`);
	} catch {
		report('Could not launch open');
	}
}
