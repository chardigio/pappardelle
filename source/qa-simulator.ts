import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createLogger} from './logger.ts';
import {isSimctlUnavailableError} from './simctl-check.ts';

const log = createLogger('qa-simulator');
const execFileAsync = promisify(execFile);
type SimctlRunner = (args: string[], timeout: number) => Promise<string>;
const runSimctl: SimctlRunner = async (args, timeout) => {
	const {stdout} = await execFileAsync('xcrun', ['simctl', ...args], {
		encoding: 'utf-8',
		timeout,
	});
	return stdout;
};

export class QaSimulatorCleanup {
	private readonly pending = new Map<string, (success: boolean) => void>();
	private readonly jobs = new Map<string, Promise<boolean>>();
	private running = false;
	private unavailableUntil = 0;

	constructor(
		private readonly run: SimctlRunner = runSimctl,
		private readonly shouldDelete?: (key: string) => boolean,
		private readonly now: () => number = Date.now,
	) {}

	async delete(issueKey: string): Promise<boolean> {
		const existing = this.jobs.get(issueKey);
		if (existing) return existing;
		const job = new Promise<boolean>(resolve => {
			this.pending.set(issueKey, resolve);
		});
		this.jobs.set(issueKey, job);
		this.schedule();
		return job;
	}

	private schedule(): void {
		if (this.running || this.pending.size === 0) return;
		this.running = true;
		setImmediate(() => {
			void this.flush();
		});
	}

	private async flush(): Promise<void> {
		const batch = new Map(this.pending);
		this.pending.clear();
		try {
			const devices = await this.listDevices();
			for (const [key, resolve] of batch) {
				const device = devices.find(item => item.name === `QA-${key}`);
				let success = true;
				if (device && this.shouldDelete?.(key) !== false) {
					try {
						await this.run(['delete', device.udid], 30_000);
						log.info(`Deleted QA simulator: ${device.name} (${device.udid})`);
					} catch (err) {
						log.error(
							`Failed to delete simulator for ${key}`,
							err instanceof Error ? err : undefined,
						);
						success = false;
					}
				}
				this.jobs.delete(key);
				resolve(success);
			}
		} catch (err) {
			log.error(
				'Failed to list simulators',
				err instanceof Error ? err : undefined,
			);
			for (const [key, resolve] of batch) {
				this.jobs.delete(key);
				resolve(false);
			}
		} finally {
			this.running = false;
			this.schedule();
		}
	}

	private async listDevices(): Promise<Array<{name: string; udid: string}>> {
		if (this.now() < this.unavailableUntil) return [];
		try {
			const output = await this.run(['list', 'devices', '-j'], 10_000);
			const data = JSON.parse(output) as {
				devices: Record<string, Array<{name: string; udid: string}>>;
			};
			return Object.values(data.devices).flat();
		} catch (err) {
			const error = err as NodeJS.ErrnoException & {stderr?: string};
			if (
				error.code === 'ENOENT' ||
				isSimctlUnavailableError(error.stderr ?? '')
			) {
				// Recheck later so installing/selecting Xcode does not require restarting the UI.
				this.unavailableUntil = this.now() + 60_000;
				return [];
			}
			throw err;
		}
	}
}
