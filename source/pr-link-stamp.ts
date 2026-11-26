/**
 * When a PR was last linked, on this machine, in any repo. `pappardelle
 * link-pr` runs in another process than the rail. Touching the stamp tells
 * every running rail that GitHub is reachable again, so a lookup that failed
 * earlier (say, before `gh auth login`) retries right away.
 */
export interface PrLinkStampDao {
	touch(): Promise<void>;
	/** The time of the last touch in milliseconds, or 0 when there was none. */
	read(): number;
}
