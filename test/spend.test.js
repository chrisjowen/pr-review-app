import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AllowanceError, createSpend } from '../src/spend.js';
import { addUser, dbOptions, freshDb } from './helpers.js';

describe('the free allowance’s caps', dbOptions(), () => {
	let t;
	before(async () => (t = await freshDb()));
	after(async () => t?.drop());

	const spendOf = (caps, now) => createSpend({ db: t.db, caps, ...(now ? { now } : {}) });

	it('reserves under the caps, and settles at what a call cost', async () => {
		const spend = spendOf({ userUsd: 0.25, globalUsd: 10 });
		const u = await addUser(t.db);
		const id = await spend.reserve(u, 0.1, 'm');
		assert.deepEqual(await spend.totals(u), { day: spend.day(), user: 0.1, global: 0.1 });
		await spend.settle(id, { costUsd: 0.02, promptTokens: 10, outputTokens: 20 });
		const after = await spend.totals(u);
		assert.equal(after.user, 0.02);
		const { rows } = await t.db.query(
			'SELECT state, cost_usd, output_tokens FROM ai_spend WHERE id = $1',
			[id]
		);
		assert.deepEqual(rows[0], { state: 'settled', cost_usd: 0.02, output_tokens: 20 });
		assert.equal(await spend.blocked(u), null);
	});

	it('refuses a call that would take a user past their daily cap', async () => {
		const spend = spendOf({ userUsd: 0.25, globalUsd: 10 });
		const u = await addUser(t.db);
		await spend.reserve(u, 0.2, 'm');
		await assert.rejects(spend.reserve(u, 0.1, 'm'), (e) => {
			assert.ok(e instanceof AllowanceError);
			assert.equal(e.scope, 'user');
			assert.match(e.message, /isn’t enough of today’s free AI allowance left/);
			return true;
		});
		// A smaller step still fits.
		await spend.reserve(u, 0.05, 'm');
		assert.match(await spend.blocked(u), /You’ve used today’s free AI allowance \(\$0\.25\)/);
		await assert.rejects(spend.reserve(u, 0, 'm'), /used today’s free AI allowance/);
		// Someone else is unaffected.
		await spend.reserve(await addUser(t.db), 0.2, 'm');
	});

	it('refuses everyone once the global daily cap is reached', async () => {
		const spend = spendOf({ userUsd: 5, globalUsd: 10 });
		const used = (await spend.totals(0)).global;
		const capped = spendOf({ userUsd: 5, globalUsd: used + 1 });
		const a = await addUser(t.db);
		const b = await addUser(t.db);
		await capped.reserve(a, 0.6, 'm');
		await assert.rejects(capped.reserve(b, 0.6, 'm'), (e) => e.scope === 'global');
		await capped.reserve(b, 0.3, 'm');
		await assert.rejects(capped.reserve(b, 0.2, 'm'), /budget for everyone is used up/);
		assert.equal(await capped.blocked(b), null, 'a small step would still fit');
		const full = spendOf({ userUsd: 5, globalUsd: (await spend.totals(0)).global });
		assert.match(await full.blocked(b), /budget for everyone/);
		await assert.rejects(full.reserve(b, 0, 'm'), (e) => e.scope === 'global');
	});

	it('never lets racing calls share the last of the allowance', async () => {
		const spend = spendOf({ userUsd: 1, globalUsd: 1000 });
		const u = await addUser(t.db);
		const tries = await Promise.allSettled(
			Array.from({ length: 20 }, () => spend.reserve(u, 0.15, 'm'))
		);
		assert.equal(tries.filter((x) => x.status === 'fulfilled').length, 6);
		assert.ok((await spend.totals(u)).user <= 1);
	});

	it('counts a reservation never settled in full (a call that died mid-way)', async () => {
		const spend = spendOf({ userUsd: 0.25, globalUsd: 10 });
		const u = await addUser(t.db);
		await spend.reserve(u, 0.25, 'm');
		assert.match(await spend.blocked(u), /used today’s/);
	});

	it('starts afresh each UTC day', async () => {
		let now = Date.parse('2026-11-02T23:59:00Z');
		const spend = spendOf({ userUsd: 0.25, globalUsd: 10 }, () => now);
		const u = await addUser(t.db);
		await spend.reserve(u, 0.25, 'm');
		assert.ok(await spend.blocked(u));
		now = Date.parse('2026-11-03T00:00:30Z');
		assert.equal(await spend.blocked(u), null);
		assert.equal((await spend.totals(u)).user, 0);
	});

	it('doesn’t settle twice, or below zero', async () => {
		const spend = spendOf({ userUsd: 1, globalUsd: 10 });
		const u = await addUser(t.db);
		const id = await spend.reserve(u, 0.5, 'm');
		await spend.settle(id, { costUsd: -3 });
		await spend.settle(id, { costUsd: 0.4 });
		assert.equal((await spend.totals(u)).user, 0);
		await assert.rejects(spend.reserve(u, Number.NaN, 'm'), /needs a cost/);
	});
});
