import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
	allowanceModel,
	cacheKey,
	offModel,
	ownKeyModel,
	pgCache,
	promptTokens
} from '../src/reviewer.js';
import { createSpend } from '../src/spend.js';
import { addUser, dbOptions, fakeProvider, freshDb } from './helpers.js';

const AI = {
	baseUrl: 'https://openrouter.example/api/v1',
	apiKey: 'server-key',
	model: 'cheap/model',
	label: 'Cheap model',
	priceIn: 1,
	priceOut: 2,
	maxTokens: { json: 1000, chat: 500 }
};
const ask = (content, json = true) => ({ messages: [{ role: 'user', content }], json });

describe('sizing a call', () => {
	it('errs high on prompt tokens', () => {
		const text = 'x'.repeat(4000);
		assert.ok(promptTokens([{ role: 'user', content: text }]) >= 1000);
	});
	it('keys the cache by the model and exactly what was asked', () => {
		const m = [{ role: 'user', content: 'a' }];
		assert.equal(cacheKey('x', m), cacheKey('x', structuredClone(m)));
		assert.notEqual(cacheKey('x', m), cacheKey('y', m));
		assert.notEqual(cacheKey('x', m), cacheKey('x', [{ role: 'user', content: 'b' }]));
	});
});

describe('the reviewer on the free allowance', dbOptions(), () => {
	let t;
	before(async () => (t = await freshDb()));
	after(async () => t?.drop());

	const make = (caps, provider, extra = {}) =>
		allowanceModel({
			ai: AI,
			userId: extra.userId,
			spend: createSpend({ db: t.db, caps }),
			cache: pgCache(t.db),
			fetch: provider.fetch,
			...extra
		});

	it('reserves before calling, then settles at the reported usage', async () => {
		const userId = await addUser(t.db);
		const p = fakeProvider(() => '{"summary":"fine"}');
		const m = make({ userUsd: 1, globalUsd: 10 }, p, { userId });
		assert.deepEqual(await m.check(), { ok: true });
		const out = await m.generate(ask('review this'));
		assert.equal(out.text, '{"summary":"fine"}');
		assert.equal(p.calls.length, 1);
		assert.equal(p.calls[0].url, 'https://openrouter.example/api/v1/chat/completions');
		assert.equal(p.calls[0].headers.authorization, 'Bearer server-key');
		assert.equal(p.calls[0].body.max_tokens, 1000, 'each answer is bounded');
		const { rows } = await t.db.query(
			'SELECT state, reserved_usd, cost_usd FROM ai_spend WHERE user_id = $1',
			[userId]
		);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].state, 'settled');
		// 100 prompt tokens at $1/M and 50 output tokens at $2/M.
		assert.equal(rows[0].cost_usd, 0.0002);
		assert.ok(rows[0].reserved_usd >= 0.002, 'reserved the whole output budget');
	});

	it('never calls the provider once a cap is reached', async () => {
		const userId = await addUser(t.db);
		const p = fakeProvider();
		// The cap is below what one call could cost, so even the first is refused.
		const m = make({ userUsd: 0.001, globalUsd: 10 }, p, { userId });
		await assert.rejects(m.generate(ask('one')), /isn’t enough of today’s free AI allowance/);
		assert.equal(p.calls.length, 0);
		const g = make({ userUsd: 1, globalUsd: 0 }, p, { userId });
		assert.match((await g.check()).reason, /budget for everyone/);
		await assert.rejects(g.generate(ask('two')), /budget for everyone/);
		assert.equal(p.calls.length, 0);
	});

	it('answers the same question again from the cache, free, for anyone', async () => {
		const a = await addUser(t.db);
		const b = await addUser(t.db);
		const p = fakeProvider(() => '{"stops":[]}');
		const caps = { userUsd: 1, globalUsd: 10 };
		await make(caps, p, { userId: a }).generate(ask('the same stage'));
		const out = await make(caps, p, { userId: b }).generate(ask('the same stage'));
		assert.equal(out.cached, true);
		assert.equal(out.text, '{"stops":[]}');
		assert.equal(p.calls.length, 1);
		const { rows } = await t.db.query(
			'SELECT count(*)::int AS n FROM ai_spend WHERE user_id = $1',
			[b]
		);
		assert.equal(rows[0].n, 0);
	});

	it('asks afresh for "Read again", and never caches chat or a non-JSON answer', async () => {
		const userId = await addUser(t.db);
		const p = fakeProvider((body) => (body.messages[0].content === 'bad' ? 'not json' : '{"n":1}'));
		const caps = { userUsd: 1, globalUsd: 10 };
		let fresh = false;
		const m = make(caps, p, { userId, fresh: () => fresh });
		await m.generate(ask('again'));
		fresh = true;
		await m.generate(ask('again'));
		assert.equal(p.calls.length, 2);
		fresh = false;
		await m.generate(ask('chat', false));
		await m.generate(ask('chat', false));
		assert.equal(p.calls.length, 4);
		assert.equal(p.calls[2].body.max_tokens, 500);
		await m.generate(ask('bad'));
		await m.generate(ask('bad'));
		assert.equal(p.calls.length, 6);
	});

	it('keeps the whole reservation when a call fails', async () => {
		const userId = await addUser(t.db);
		const failing = { fetch: async () => new Response('overloaded', { status: 503 }) };
		const m = make({ userUsd: 1, globalUsd: 10 }, failing, { userId });
		await assert.rejects(m.generate(ask('x')), /answered 503/);
		const { rows } = await t.db.query(
			'SELECT state, reserved_usd, cost_usd FROM ai_spend WHERE user_id = $1',
			[userId]
		);
		assert.equal(rows[0].state, 'settled');
		assert.equal(rows[0].cost_usd, rows[0].reserved_usd);
	});
});

describe('the reviewer on a user’s own key', () => {
	it('calls only that provider’s fixed URL, with their key, unmetered', async () => {
		const p = fakeProvider(() => '{}');
		const m = ownKeyModel({
			provider: 'openrouter',
			apiKey: 'sk-or-user',
			model: 'some/model',
			fetch: p.fetch
		});
		assert.equal(m.name, 'some/model (your OpenRouter key)');
		await m.generate(ask('hi'));
		assert.equal(p.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
		assert.equal(p.calls[0].headers.authorization, 'Bearer sk-or-user');
		assert.equal(p.calls[0].body.model, 'some/model');
		const o = ownKeyModel({ provider: 'openai', apiKey: 'sk-user', model: '', fetch: p.fetch });
		await o.generate(ask('hi'));
		assert.equal(p.calls[1].url, 'https://api.openai.com/v1/chat/completions');
		assert.throws(() => ownKeyModel({ provider: 'evil', apiKey: 'k' }), /Unknown provider/);
	});
});

describe('no live AI', () => {
	it('says why and never calls anything', async () => {
		const m = offModel('Live AI is off.');
		assert.deepEqual(await m.check(), { ok: false, reason: 'Live AI is off.' });
		await assert.rejects(m.generate(ask('x')), /Live AI is off/);
	});
});
