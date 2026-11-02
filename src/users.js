/**
 * Users and the keys they bring. A GitHub user is found by their GitHub id
 * (their login can change); a demo user is new each time. A key is checked,
 * sealed for its owner and only ever unsealed to make that owner's calls.
 */

import { MODEL_NAME, PROVIDERS } from './reviewer.js';

/**
 * @param {{ db: ReturnType<typeof import('./db.js').createDb>; sealer: ReturnType<typeof import('./seal.js').createSealer> }} o
 */
export function createUsers({ db, sealer }) {
	const shape = (r) => ({ id: Number(r.id), login: r.login, name: r.name, kind: r.kind });
	return {
		/** The user for a signed-in identity, made on first sign-in and kept up to date after. */
		async upsert({ githubId, login, name, kind }) {
			if (kind === 'github') {
				const { rows } = await db.query(
					`INSERT INTO users (github_id, login, name, kind) VALUES ($1, $2, $3, 'github')
					 ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name, last_seen_at = now()
					 RETURNING id, login, name, kind`,
					[githubId, login, name]
				);
				return shape(rows[0]);
			}
			const { rows } = await db.query(
				`INSERT INTO users (login, name, kind) VALUES ($1, $2, 'demo') RETURNING id, login, name, kind`,
				[login, name]
			);
			return shape(rows[0]);
		},

		async exists(id) {
			return (await db.query('SELECT 1 FROM users WHERE id = $1', [id])).rowCount === 1;
		},

		/** Which key a user has saved (never the key itself). */
		async keyInfo(userId) {
			const { rows } = await db.query('SELECT provider, model FROM user_keys WHERE user_id = $1', [
				userId
			]);
			const r = rows[0];
			return r && PROVIDERS[r.provider]
				? { provider: r.provider, model: r.model, label: PROVIDERS[r.provider].label }
				: null;
		},

		/** The user's key, unsealed, to make their calls with; null if none or it no longer opens. */
		async key(userId) {
			const { rows } = await db.query(
				'SELECT provider, model, sealed FROM user_keys WHERE user_id = $1',
				[userId]
			);
			const r = rows[0];
			if (!r || !PROVIDERS[r.provider]) return null;
			const apiKey = sealer.unseal(r.sealed, userId);
			return apiKey ? { provider: r.provider, model: r.model, apiKey } : null;
		},

		async saveKey(userId, { provider, key, model }) {
			if (!Object.hasOwn(PROVIDERS, provider)) throw new Error('Pick OpenRouter or OpenAI.');
			const k = String(key ?? '').trim();
			if (!/^[\w.-]{20,300}$/.test(k)) throw new Error('That doesn’t look like an API key.');
			const m = String(model ?? '').trim() || PROVIDERS[provider].model;
			if (!MODEL_NAME.test(m)) throw new Error('That isn’t a model name.');
			await db.query(
				`INSERT INTO user_keys (user_id, provider, model, sealed, updated_at) VALUES ($1, $2, $3, $4, now())
				 ON CONFLICT (user_id) DO UPDATE SET provider = EXCLUDED.provider, model = EXCLUDED.model, sealed = EXCLUDED.sealed, updated_at = now()`,
				[userId, provider, m, sealer.seal(k, userId)]
			);
		},

		async clearKey(userId) {
			await db.query('DELETE FROM user_keys WHERE user_id = $1', [userId]);
		},

		/**
		 * Forgets what is kept for a user: their reviews, prompts and key. The user row and
		 * the spend ledger stay, so signing in again doesn't reset today's allowance.
		 */
		async forget(userId) {
			await db.tx(async (c) => {
				for (const table of ['reviews', 'user_prompts', 'user_keys'])
					await c.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
			});
		}
	};
}
