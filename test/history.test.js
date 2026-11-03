import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHistory, summarize } from '../src/history.js';
import { ago, reviewList } from '../src/pages.js';
import { addUser, dbOptions, freshDb } from './helpers.js';

/** A kept review, as the engine writes it: two stages' cards, and the reviewer's decisions on some. */
function review(over = {}) {
	return {
		id: 'o__r__7',
		rev: 4,
		updatedAt: 1_700_000_000_000,
		pr: {
			owner: 'o',
			repo: 'r',
			number: 7,
			title: 'Teach the engine new tricks',
			url: 'https://github.com/o/r/pull/7',
			headSha: 'abc1234def'
		},
		files: [{ path: 'src/engine/core.js', hunks: [] }],
		plan: { generated: ['package-lock.json'] },
		stages: [
			{ id: 'stop-1', kind: 'change', files: [] },
			{ id: 'quality', kind: 'quality', files: [] }
		],
		results: {
			'stop-1': {
				cards: [
					{ id: 'stop-1:c1', verdict: 'lgtm' },
					{ id: 'stop-1:c2', verdict: 'security' },
					{ id: 'stop-1:c3', verdict: 'smell' }
				]
			},
			quality: { cards: [{ id: 'quality:c1', verdict: 'exemplary' }] }
		},
		chat: { 'stop-1:c1': [{ who: 'me', text: 'Why?' }] },
		requests: [],
		cardDecisions: {
			'stop-1:c1': { decision: 'accept' },
			'stop-1:c2': { decision: 'comment', text: 'Fix' }
		},
		posted: null,
		...over
	};
}

describe('summing up a kept review', () => {
	it('counts its changes, the ones decided, and files each the way the chat does', () => {
		const s = summarize(review());
		assert.equal(s.cards, 5, 'four cards and the generated files');
		assert.equal(s.decided, 2);
		assert.deepEqual(s.parts, { like: 2, note: 1, work: 1, serious: 1 });
		assert.equal(s.title, 'Teach the engine new tricks');
		assert.equal(s.headSha, 'abc1234def');
		assert.equal(s.posted, null);
	});

	it('says how long ago, with the moment on hover', () => {
		const now = Date.UTC(2026, 10, 3, 12);
		assert.match(ago(now - 30_000, now), />just now</);
		assert.match(ago(now - 3 * 3600_000, now), />3 hours ago</);
		assert.match(ago(now - 86_400_000, now), />1 day ago</);
		assert.match(ago(now - 90 * 86_400_000, now), />2026-08-05</);
		assert.match(ago(now, now), /title="2026-11-03 12:00 UTC"/);
		assert.equal(ago(undefined, now), '');
	});

	it('lists reviews linking back to each, with what GitHub was told', () => {
		const html = reviewList([
			summarize(
				review({
					posted: {
						at: 1,
						event: 'REQUEST_CHANGES',
						url: 'https://github.com/o/r/pull/7#pullrequestreview-1'
					}
				})
			)
		]);
		assert.match(html, /href="\/o\/r\/pull\/7\/review"/);
		assert.match(html, /2 of 5 changes decided/);
		assert.match(html, /Changes requested/);
		assert.match(html, /href="https:\/\/github\.com\/o\/r\/pull\/7#pullrequestreview-1"/);
		assert.match(html, /<b>1<\/b> serious/);
		const evil = reviewList([
			summarize(review({ pr: { owner: '<x>', repo: 'r', number: 1, title: '<script>' } }))
		]);
		assert.ok(!evil.includes('<script>'));
		assert.ok(!evil.includes('<x>'));
	});
});

describe('the reviews already done, over Postgres', dbOptions(), () => {
	let t;
	before(async () => (t = await freshDb()));
	after(async () => t?.drop());

	const keep = (userId, r) =>
		t.db.query('INSERT INTO reviews (user_id, id, review) VALUES ($1, $2, $3)', [
			userId,
			r.id,
			JSON.stringify(r)
		]);

	it('lists a user’s own reviews, the latest first, leaving out demo reviews never opened', async () => {
		const seed = review({ id: 'chrisjowen__docket__48', rev: 3065 });
		const history = createHistory({ db: t.db, seeds: [seed] });
		const me = await addUser(t.db);
		const other = await addUser(t.db);
		await keep(me, seed);
		await keep(me, review());
		await t.db.query(
			"UPDATE reviews SET updated_at = now() - interval '1 hour' WHERE id = 'o__r__7'"
		);
		await keep(me, review({ id: 'o__r__8', pr: { ...review().pr, number: 8, title: 'Later' } }));
		await keep(other, review({ id: 'o__r__9' }));
		const mine = await history.mine(me);
		assert.deepEqual(
			mine.map((s) => s.id),
			['o__r__8', 'o__r__7']
		);
		assert.equal((await history.mine(me, { limit: 1 })).length, 1);
		assert.equal(await history.mineOf(me, 'chrisjowen__docket__48'), null);
		// Opened, the demo review is theirs.
		await t.db.query(
			"UPDATE reviews SET review = jsonb_set(review, '{rev}', '3066') WHERE user_id = $1 AND id = 'chrisjowen__docket__48'",
			[me]
		);
		assert.equal((await history.mine(me)).length, 3);
		assert.equal((await history.mineOf(me, 'o__r__7')).decided, 2);
		assert.equal(await history.mineOf(other, 'o__r__7'), null);
	});

	it('lists the reviews of one PR posted from here, whoever posted them, and nothing unposted', async () => {
		const history = createHistory({ db: t.db });
		const a = await addUser(t.db, 'alice');
		const b = await addUser(t.db, 'bob');
		const c = await addUser(t.db, 'carol');
		const id = 'o__r__70';
		await keep(
			a,
			review({
				id,
				posted: {
					at: 1000,
					event: 'APPROVE',
					url: 'https://github.com/o/r/pull/70#r-1',
					note: null
				}
			})
		);
		await keep(
			b,
			review({
				id,
				pr: { ...review().pr, headSha: 'old0000' },
				posted: {
					at: 2000,
					event: 'COMMENT',
					url: 'https://github.com/o/r/pull/70#r-2',
					note: null
				}
			})
		);
		await keep(c, review({ id }));
		const posted = await history.posted(id);
		assert.deepEqual(
			posted.map((p) => [p.login, p.event, p.headSha]),
			[
				['bob', 'COMMENT', 'old0000'],
				['alice', 'APPROVE', 'abc1234def']
			]
		);
		assert.deepEqual(await history.posted('o__r__71'), []);
	});
});
