/**
 * The reviewer a user gets, as the shared engine's model interface
 * (`{ name, check(), generate() }`):
 *
 * - their own key (bring your own: OpenRouter or OpenAI), unmetered;
 * - else the server's model on the free allowance: every call reserves its
 *   most possible cost against the caps first (see spend.js), and stage
 *   answers are cached by what was asked, so a second review of the same PR
 *   head with the same prompts is free;
 * - else no live AI: the reviewer says why.
 */

import { createHash } from 'node:crypto';
import { createOpenAI } from 'pr-review-wheelhouse/wheelhouse/engine/model.js';
import { parseJson } from 'pr-review-wheelhouse/wheelhouse/engine/prompts.js';
import { AllowanceError } from './spend.js';

/** Providers a user may bring a key for. Only these base URLs are ever called with a user's key. */
export const PROVIDERS = {
	openrouter: {
		label: 'OpenRouter',
		baseUrl: 'https://openrouter.ai/api/v1',
		model: 'anthropic/claude-haiku-5.5'
	},
	openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' }
};

export const MODEL_NAME = /^[\w.:/-]{1,100}$/;

/** Roughly how many tokens a conversation is, erring high (English and code run nearer 4 characters a token). */
export function promptTokens(messages) {
	return Math.ceil(messages.reduce((n, m) => n + String(m.content ?? '').length + 8, 0) / 3) + 16;
}

/** The cache key for one question: the model and exactly what it was asked. */
export function cacheKey(model, messages) {
	return createHash('sha256')
		.update(JSON.stringify([model, messages]))
		.digest('hex');
}

/**
 * The server's model on the free allowance.
 *
 * @param {{
 *   ai: { baseUrl: string; apiKey: string; model: string; label: string; priceIn: number; priceOut: number; maxTokens: { json: number; chat: number }; headers?: Record<string, string> };
 *   userId: number;
 *   spend: ReturnType<typeof import('./spend.js').createSpend>;
 *   cache: { get(key: string): Promise<any>; put(key: string, model: string, answer: any): Promise<void> };
 *   fresh?: () => boolean;
 *   fetch?: typeof fetch;
 *   log?: (line: string) => void;
 * }} o
 */
export function allowanceModel({
	ai,
	userId,
	spend,
	cache,
	fresh = () => false,
	fetch,
	log = () => {}
}) {
	const make = (maxTokens) =>
		createOpenAI({
			baseUrl: ai.baseUrl,
			apiKey: ai.apiKey,
			model: ai.model,
			maxTokens,
			headers: ai.headers,
			...(fetch ? { fetch } : {})
		});
	const forJson = make(ai.maxTokens.json);
	const forChat = make(ai.maxTokens.chat);
	const price = (tin, tout) => (tin * ai.priceIn + tout * ai.priceOut) / 1e6;
	return {
		name: ai.label,
		async check() {
			const reason = await spend.blocked(userId);
			return reason ? { ok: false, reason } : { ok: true };
		},
		async generate(req) {
			const key = req.json ? cacheKey(ai.model, req.messages) : null;
			if (key && !fresh()) {
				const hit = await cache.get(key).catch(() => null);
				if (hit) return { ...hit, costUsd: 0, ms: 0, cached: true };
			}
			const most = price(
				promptTokens(req.messages),
				req.json ? ai.maxTokens.json : ai.maxTokens.chat
			);
			let id;
			try {
				id = await spend.reserve(userId, most, ai.model);
			} catch (e) {
				if (e instanceof AllowanceError) throw new Error(e.message, { cause: e });
				throw e;
			}
			let out;
			try {
				out = await (req.json ? forJson : forChat).generate(req);
			} catch (e) {
				// It may have cost something before it failed: keep the whole reservation.
				await spend.settle(id, { costUsd: most }).catch((x) => log(`settle failed: ${x.message}`));
				throw e;
			}
			const cost =
				typeof out.costUsd === 'number' ? out.costUsd : price(out.promptTokens, out.outputTokens);
			await spend
				.settle(id, {
					costUsd: cost,
					promptTokens: out.promptTokens,
					outputTokens: out.outputTokens
				})
				.catch((x) => log(`settle failed: ${x.message}`));
			if (key && parseJson(out.text))
				await cache
					.put(key, ai.model, {
						text: out.text,
						promptTokens: out.promptTokens,
						outputTokens: out.outputTokens
					})
					.catch((x) => log(`cache put failed: ${x.message}`));
			return out;
		}
	};
}

/** A user's own key: their provider, their model, their bill. */
export function ownKeyModel({ provider, apiKey, model, fetch }) {
	const p = PROVIDERS[provider];
	if (!p) throw new Error('Unknown provider.');
	const m = createOpenAI({
		baseUrl: p.baseUrl,
		apiKey,
		model: model || p.model,
		headers:
			provider === 'openrouter'
				? { 'x-title': 'PR review for humans', 'http-referer': 'https://pr.chrisjowen.net' }
				: {},
		...(fetch ? { fetch } : {})
	});
	return { ...m, name: `${model || p.model} (your ${p.label} key)` };
}

/** No live AI for this user: say why, and never call anything. */
export function offModel(reason) {
	return {
		name: 'The reviewer',
		async check() {
			return { ok: false, reason };
		},
		async generate() {
			throw new Error(reason);
		}
	};
}

/** The shared answer cache, in Postgres. */
export function pgCache(db) {
	return {
		async get(key) {
			const { rows } = await db.query('SELECT answer FROM ai_cache WHERE key = $1', [key]);
			return rows[0]?.answer ?? null;
		},
		async put(key, model, answer) {
			await db.query(
				'INSERT INTO ai_cache (key, model, answer) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING',
				[key, model, answer]
			);
		}
	};
}
