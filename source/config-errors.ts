export class ConfigNotFoundError extends Error {
	repoRoot: string;

	constructor(repoRoot: string) {
		super(`No .pappardelle.yml found at repository root: ${repoRoot}`);
		this.name = 'ConfigNotFoundError';
		this.repoRoot = repoRoot;
	}
}

export function formatConfigErrors(errors: string[]): string {
	return `Invalid .pappardelle.yml configuration:\n${errors
		.map(e => `  - ${e}`)
		.join('\n')}`;
}

/** The errors on one line, for the rail and other one-line places; a YAML error's code excerpt is dropped. */
export function inlineConfigErrors(errors: string[]): string {
	return errors
		.map(error => error.split('\n')[0]!.trim().replace(/:$/, ''))
		.join('; ');
}

export class ConfigValidationError extends Error {
	errors: string[];

	constructor(errors: string[]) {
		super(formatConfigErrors(errors));
		this.name = 'ConfigValidationError';
		this.errors = errors;
	}
}

export class NotInGitRepoError extends Error {
	constructor() {
		super('Not in a git repository');
		this.name = 'NotInGitRepoError';
	}
}
