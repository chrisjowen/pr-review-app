/**
 * Everything the site is configured with, from the environment. Secrets come
 * from a Kubernetes secret in the cluster (or your shell locally) and are
 * never in the image or the repository.
 *
 * Required:
 *   DATABASE_URL                  Postgres
 *   PRREVIEW_SESSION_SECRET       signs session cookies (32+ characters)
 *   PRREVIEW_SEAL_KEY             seals the keys users bring (openssl rand -hex 32)
 * Optional:
 *   PORT (8080), PRREVIEW_ORIGIN (http://localhost:$PORT)
 *   PRREVIEW_GITHUB_CLIENT_ID, PRREVIEW_GITHUB_CLIENT_SECRET   Sign in with GitHub (a GitHub App, or an OAuth App)
 *   PRREVIEW_GITHUB_APP_SLUG      the GitHub App's slug, to link its install page when it can't post
 *   PRREVIEW_GITHUB_TOKEN         reads public PRs with 5,000 API calls an hour instead of 60
 *   PRREVIEW_DEMO_LOGIN=1         a throwaway demo login, for local use (refused with an https origin)
 *   OPENROUTER_API_KEY            turns on the free AI allowance (or PRREVIEW_AI_API_KEY for another provider)
 *   PRREVIEW_AI_BASE_URL, PRREVIEW_AI_MODEL, PRREVIEW_AI_LABEL
 *   PRREVIEW_AI_PRICE_IN, PRREVIEW_AI_PRICE_OUT   USD per million tokens, for the caps
 *   PRREVIEW_AI_MAX_TOKENS, PRREVIEW_AI_CHAT_MAX_TOKENS   the most one answer may be
 *   PRREVIEW_QUOTA_USER_USD (0.25), PRREVIEW_QUOTA_GLOBAL_USD (10)   hard daily caps, UTC days
 *   PRREVIEW_DEMO_PR, PRREVIEW_SEED_DIR   the demo PR and its pre-generated reviews
 *   PRREVIEW_FRAME_ANCESTORS      origins that may frame the site, space-separated ('none' by default)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSealKey } from './seal.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The CSP's frame-ancestors: 'none' unless origins are listed (a local preview embedded in a tool). */
export function frameAncestors(raw) {
	const list = String(raw ?? '')
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (!list.length) return "'none'";
	for (const s of list)
		if (!/^('none'|'self'|https?:\/\/(\*\.)?[\w.-]+(:\d+)?)$/.test(s))
			throw new Error(
				`PRREVIEW_FRAME_ANCESTORS must list origins like http://localhost:4310, not ${s}.`
			);
	return list.join(' ');
}

function number(env, name, fallback, { min = 0 } = {}) {
	const raw = env[name];
	if (raw === undefined || raw === '') return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < min)
		throw new Error(`${name} must be a number of at least ${min}.`);
	return n;
}

export function readConfig(env = process.env) {
	const port = number(env, 'PORT', 8080, { min: 1 });
	const origin = (env.PRREVIEW_ORIGIN || `http://localhost:${port}`).replace(/\/+$/, '');
	if (!/^https?:\/\/[^/]+$/.test(origin))
		throw new Error('PRREVIEW_ORIGIN must be a scheme and host, like https://pr.chrisjowen.net.');
	if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
	const apiKey = env.PRREVIEW_AI_API_KEY || env.OPENROUTER_API_KEY || '';
	const model = env.PRREVIEW_AI_MODEL || 'anthropic/claude-haiku-5.5';
	return {
		port,
		origin,
		databaseUrl: env.DATABASE_URL,
		sessionSecret: env.PRREVIEW_SESSION_SECRET ?? '',
		sealKey: readSealKey(env.PRREVIEW_SEAL_KEY),
		github: {
			clientId: env.PRREVIEW_GITHUB_CLIENT_ID || '',
			clientSecret: env.PRREVIEW_GITHUB_CLIENT_SECRET || '',
			oauthUrl: env.PRREVIEW_GITHUB_OAUTH_URL || '',
			apiUrl: env.PRREVIEW_GITHUB_API_URL || '',
			appSlug: /^[\w-]{1,100}$/.test(env.PRREVIEW_GITHUB_APP_SLUG ?? '')
				? env.PRREVIEW_GITHUB_APP_SLUG
				: '',
			token: env.PRREVIEW_GITHUB_TOKEN || ''
		},
		demoLogin: env.PRREVIEW_DEMO_LOGIN === '1',
		ai: apiKey
			? {
					baseUrl: (env.PRREVIEW_AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
					apiKey,
					model,
					label: env.PRREVIEW_AI_LABEL || model,
					priceIn: number(env, 'PRREVIEW_AI_PRICE_IN', 0.1),
					priceOut: number(env, 'PRREVIEW_AI_PRICE_OUT', 0.5),
					maxTokens: {
						json: number(env, 'PRREVIEW_AI_MAX_TOKENS', 8192, { min: 256 }),
						chat: number(env, 'PRREVIEW_AI_CHAT_MAX_TOKENS', 2048, { min: 256 })
					},
					headers: { 'x-title': 'PR review for humans', 'http-referer': origin }
				}
			: null,
		caps: {
			userUsd: number(env, 'PRREVIEW_QUOTA_USER_USD', 0.25),
			globalUsd: number(env, 'PRREVIEW_QUOTA_GLOBAL_USD', 10)
		},
		frameAncestors: frameAncestors(env.PRREVIEW_FRAME_ANCESTORS),
		demoPr: env.PRREVIEW_DEMO_PR || 'https://github.com/chrisjowen/docket/pull/48',
		seedDir: env.PRREVIEW_SEED_DIR || path.join(ROOT, 'seed')
	};
}

/**
 * The model's live price on OpenRouter, when it is dearer than the configured one, so the caps
 * never undercount. Leaves the configured prices when OpenRouter can't be asked.
 */
export async function checkPrices(ai, { fetch: get = fetch, log = () => {} } = {}) {
	if (!ai || !/openrouter\.ai/.test(ai.baseUrl)) return ai;
	try {
		const res = await get(`${ai.baseUrl}/models`, { signal: AbortSignal.timeout(10_000) });
		const found = (await res.json())?.data?.find((m) => m.id === ai.model);
		if (!found) {
			log(`price check: ${ai.model} isn’t listed on OpenRouter; keeping the configured prices`);
			return ai;
		}
		const pin = Number(found.pricing?.prompt) * 1e6;
		const pout = Number(found.pricing?.completion) * 1e6;
		const next = {
			...ai,
			priceIn: Number.isFinite(pin) ? Math.max(ai.priceIn, pin) : ai.priceIn,
			priceOut: Number.isFinite(pout) ? Math.max(ai.priceOut, pout) : ai.priceOut
		};
		log(`price check: ${ai.model} at $${next.priceIn}/M in, $${next.priceOut}/M out`);
		return next;
	} catch (e) {
		log(`price check failed (${e.message}); keeping the configured prices`);
		return ai;
	}
}
