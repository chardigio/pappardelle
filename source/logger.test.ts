import test from 'ava';
import {
	createLogger,
	pruneExpiredErrors,
	getRecentErrors,
	clearRecentErrors,
	subscribeToErrors,
} from './logger.ts';

const log = createLogger('test');

test.beforeEach(() => {
	clearRecentErrors();
});

// ============================================================================
// Pruning Tests
// ============================================================================

test.serial('pruneExpiredErrors removes all errors when time passes', t => {
	log.error('transient failure');
	log.error('another failure');
	t.is(getRecentErrors().length, 2);

	// Simulate 6 minutes passing
	pruneExpiredErrors(Date.now() + 6 * 60 * 1000);
	t.is(getRecentErrors().length, 0);
});

test.serial('pruneExpiredErrors keeps errors younger than 5 minutes', t => {
	log.error('recent error 1');
	log.error('recent error 2');
	log.error('recent error 3');

	// Simulate only 3 minutes passing — all still fresh
	pruneExpiredErrors(Date.now() + 3 * 60 * 1000);
	t.is(getRecentErrors().length, 3);
});

test.serial('pruneExpiredErrors is a no-op on empty buffer', t => {
	pruneExpiredErrors(Date.now() + 10 * 60 * 1000);
	t.is(getRecentErrors().length, 0);
});

test.serial(
	'pruneExpiredErrors notifies listeners when errors are removed',
	t => {
		let notifiedCount = 0;
		const unsubscribe = subscribeToErrors(() => {
			notifiedCount++;
		});

		const baseline = notifiedCount; // subscription fires immediately

		log.error('will be pruned');
		t.is(notifiedCount, baseline + 1);

		pruneExpiredErrors(Date.now() + 6 * 60 * 1000);
		t.is(notifiedCount, baseline + 2); // notified on prune
		t.is(getRecentErrors().length, 0);

		unsubscribe();
	},
);

test.serial('pruneExpiredErrors does not notify if nothing was pruned', t => {
	let notifyCount = 0;
	const unsubscribe = subscribeToErrors(() => {
		notifyCount++;
	});

	const baseline = notifyCount;

	log.error('fresh error');
	// Only 3 minutes — nothing to prune
	pruneExpiredErrors(Date.now() + 3 * 60 * 1000);

	// Notified once for the add, but not for the no-op prune
	t.is(notifyCount, baseline + 1);

	unsubscribe();
});

test.serial('pruneExpiredErrors prunes at exactly 5 minutes', t => {
	log.error('boundary error');

	// Exactly 5 minutes later — should be pruned (cutoff uses <=)
	pruneExpiredErrors(Date.now() + 5 * 60 * 1000);
	t.is(getRecentErrors().length, 0);
});
