/**
 * One shared engine per signed-in user, made when they first use it: their
 * own reviews and prompts (a Postgres-backed store), the site's GitHub reader,
 * and the reviewer they get (their key, else the free allowance, else none).
 * The demo reviews, pre-generated, are added to each user's store so every
 * stage of them can be tried at no cost. An engine nobody has used for a
 * while, with nothing queued, is written out and let go.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHandler } from 'pr-review-wheelhouse/wheelhouse/engine/http.js';
import { createReviews } from 'pr-review-wheelhouse/wheelhouse/engine/review.js';
import { allowanceModel, offModel, ownKeyModel } from './reviewer.js';
import { loadStore } from './store.js';

/** The pre-generated demo reviews in a directory of `<id>.json` files. */
export function readSeeds(dir) {
	let names;
	try {
		names = readdirSync(dir).filter((f) => f.endsWith('.json'));
	} catch {
		return [];
	}
	return names
		.map((f) => {
			try {
				return JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
			} catch {
				return null;
			}
		})
		.filter((r) => r?.id && r.pr?.url);
}

/**
 * @param {{
 *   db: any; users: ReturnType<typeof import('./users.js').createUsers>;
 *   spend: ReturnType<typeof import('./spend.js').createSpend>;
 *   cache: any; github: any; ai: any; seeds?: any[]; version: string;
 *   log?: (line: string) => void; idleMs?: number; fetch?: typeof fetch;
 * }} o
 */
export function createEngines({
	db,
	users,
	spend,
	cache,
	github,
	ai,
	seeds = [],
	version,
	log = () => {},
	idleMs = 30 * 60_000,
	fetch
}) {
	/** @type {Map<number, Promise<any>>} */
	const engines = new Map();
	const OFF =
		'Live AI isn’t available on this site right now. Add your own OpenRouter or OpenAI key under Account to review with it.';

	async function make(user) {
		const store = await loadStore(db, user.id, { log });
		for (const r of seeds) store.seed(structuredClone(r));
		const ctx = { user, store, used: Date.now(), reviewer: offModel(OFF) };
		/** "Read again": stage passes the engine accepted to run again, each asked afresh when it runs. */
		const rereads = new Set();
		const live = (r) => {
			try {
				return ctx.reviews.view(r.id) === r;
			} catch {
				return false;
			}
		};
		const fresh = () => {
			for (const e of rereads) {
				const state = e.r.runs[e.stage]?.state;
				if (state === 'running') {
					rereads.delete(e);
					return true;
				}
				if (state !== 'queued' || !live(e.r)) rereads.delete(e);
			}
			return false;
		};
		const allowance = ai
			? allowanceModel({
					ai,
					userId: user.id,
					spend,
					cache,
					fetch,
					log,
					fresh
				})
			: null;
		/** Picks the reviewer again (after the user saves or removes a key). */
		ctx.refresh = async () => {
			const own = await users.key(user.id);
			ctx.own = own ? { provider: own.provider, model: own.model } : null;
			ctx.reviewer = own ? ownKeyModel({ ...own, fetch }) : (allowance ?? offModel(OFF));
		};
		await ctx.refresh();
		const model = () => ctx.reviewer;
		ctx.reviews = createReviews({
			github,
			store,
			model,
			log: (l) => log(`[user ${user.id}] ${l}`)
		});
		const settings = () => ({
			backend: 'web',
			label: ctx.reviewer.name,
			where: ctx.own ? 'on your key' : allowance ? 'on the free allowance' : '(live AI off)'
		});
		const reviews = {
			...ctx.reviews,
			run(id, stage) {
				const was = ctx.reviews.view(id).runs[stage]?.state;
				const r = ctx.reviews.run(id, stage);
				const state = r.runs[stage]?.state;
				if (was !== 'running' && (state === 'queued' || state === 'running'))
					rereads.add({ r, stage });
				return r;
			}
		};
		ctx.handler = createHandler({
			reviews,
			store,
			config: { get: settings, set: settings },
			version,
			model
		});
		ctx.settings = settings;
		return ctx;
	}

	async function idle(ctx) {
		let done = false;
		await Promise.race([
			ctx.reviews.settled().then(() => (done = true)),
			new Promise((r) => setTimeout(r, 0))
		]);
		return done;
	}

	async function sweep() {
		const now = Date.now();
		for (const [id, p] of engines) {
			const ctx = await p.catch(() => null);
			if (!ctx) {
				engines.delete(id);
				continue;
			}
			if (now - ctx.used < idleMs || !(await idle(ctx))) continue;
			await ctx.store.flush();
			if (ctx.store.pending()) continue;
			engines.delete(id);
		}
	}
	const timer = setInterval(() => void sweep().catch((e) => log(`sweep: ${e.message}`)), 60_000);
	timer.unref?.();

	return {
		/** The user's engine, made on first use. */
		async get(user) {
			let p = engines.get(user.id);
			if (!p) {
				p = make(user);
				engines.set(user.id, p);
				p.catch(() => engines.delete(user.id));
			}
			const ctx = await p;
			ctx.used = Date.now();
			return ctx;
		},

		/** Drops a user's engine without writing it out (after their data was deleted). */
		async drop(userId) {
			const p = engines.get(userId);
			engines.delete(userId);
			const ctx = await p?.catch(() => null);
			ctx?.reviews.stop();
			await ctx?.store.discard();
		},

		sweep,
		size: () => engines.size,

		/** Stops every engine and writes everything out. */
		async close() {
			clearInterval(timer);
			for (const p of engines.values()) {
				const ctx = await p.catch(() => null);
				if (!ctx) continue;
				ctx.reviews.stop();
				await ctx.store.flush().catch(() => {});
			}
		}
	};
}
