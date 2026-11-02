import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadStore } from '../src/store.js';
import { addUser, dbOptions, freshDb } from './helpers.js';

describe('the engine’s store over Postgres', dbOptions(), () => {
	let t;
	before(async () => (t = await freshDb()));
	after(async () => t?.drop());

	it('keeps reviews and prompts per user, across engines', async () => {
		const a = await addUser(t.db);
		const b = await addUser(t.db);
		const s = await loadStore(t.db, a, { delayMs: 5 });
		s.saveReview({ id: 'o__r__1', rev: 1 });
		s.saveReview({ id: 'o__r__1', rev: 2 });
		s.saveReview({ id: 'o__r__2', rev: 1 });
		s.savePrompts({ review: 'Be brief.' });
		s.removeReview('o__r__2');
		await s.flush();
		assert.equal(s.pending(), 0);
		const again = await loadStore(t.db, a);
		assert.deepEqual(again.reviewIds(), ['o__r__1']);
		assert.equal(again.review('o__r__1').rev, 2);
		assert.deepEqual(again.prompts(), { review: 'Be brief.' });
		const other = await loadStore(t.db, b);
		assert.deepEqual(other.reviewIds(), []);
		assert.equal(other.prompts(), null);
	});

	it('hands out copies, so the caller can’t change what is kept behind its back', async () => {
		const s = await loadStore(t.db, await addUser(t.db));
		const r = { id: 'x', list: [1] };
		s.saveReview(r);
		r.list.push(2);
		s.review('x').list.push(3);
		assert.deepEqual(s.review('x').list, [1]);
		await s.flush();
	});

	it('writes a burst of saves once, a moment later', async () => {
		const u = await addUser(t.db);
		const s = await loadStore(t.db, u, { delayMs: 30 });
		for (let i = 0; i < 50; i++) s.saveReview({ id: 'busy', rev: i });
		const { rows } = await t.db.query('SELECT count(*)::int AS n FROM reviews WHERE user_id = $1', [
			u
		]);
		assert.equal(rows[0].n, 0);
		await new Promise((r) => setTimeout(r, 120));
		const kept = await t.db.query('SELECT review FROM reviews WHERE user_id = $1', [u]);
		assert.equal(kept.rows[0].review.rev, 49);
	});

	it('adds the demo reviews only where the user has none by that id', async () => {
		const s = await loadStore(t.db, await addUser(t.db));
		assert.equal(s.seed({ id: 'demo', rev: 1 }), true);
		s.saveReview({ id: 'demo', rev: 5 });
		assert.equal(s.seed({ id: 'demo', rev: 1 }), false);
		assert.equal(s.review('demo').rev, 5);
		await s.flush();
	});

	it('writes nothing more once discarded (the user asked to be forgotten)', async () => {
		const u = await addUser(t.db);
		const s = await loadStore(t.db, u, { delayMs: 5 });
		s.saveReview({ id: 'gone', rev: 1 });
		await s.discard();
		s.saveReview({ id: 'gone', rev: 2 });
		await s.flush();
		await new Promise((r) => setTimeout(r, 30));
		const { rows } = await t.db.query('SELECT count(*)::int AS n FROM reviews WHERE user_id = $1', [
			u
		]);
		assert.equal(rows[0].n, 0);
	});
});
