/**
 * The free AI allowance, in dollars, enforced on the server before any call
 * to the server's model. Each call first reserves what it could cost at most
 * (its prompt plus its full output budget); the reservation is refused when it
 * would take the user past their daily cap or everyone past the global one.
 * After the call the reservation is settled at what it really cost. A call
 * that fails keeps its full reservation, and a reservation never settled (the
 * process died mid-call) counts in full for the day, so the caps are never
 * exceeded by what is known. Days are UTC.
 *
 * Reservations take one transaction-scoped advisory lock, so two calls racing
 * for the last cents can't both get them.
 */

const LOCK = 7_301_943;

export class AllowanceError extends Error {
	/** @param {string} message @param {'user' | 'global'} scope */
	constructor(message, scope) {
		super(message);
		this.scope = scope;
	}
}

const usd = (n) => `$${n.toFixed(2)}`;

/** @param {{ db: ReturnType<typeof import('./db.js').createDb>; caps: { userUsd: number; globalUsd: number }; now?: () => number }} o */
export function createSpend({ db, caps, now = Date.now }) {
	const day = () => new Date(now()).toISOString().slice(0, 10);
	const SPENT = 'COALESCE(SUM(COALESCE(cost_usd, reserved_usd)), 0)';

	async function totals(userId, q = db) {
		const d = day();
		const { rows } = await q.query(
			`SELECT ${SPENT} AS global,
				COALESCE(SUM(COALESCE(cost_usd, reserved_usd)) FILTER (WHERE user_id = $2), 0) AS user
			 FROM ai_spend WHERE day = $1`,
			[d, userId]
		);
		return { day: d, user: rows[0].user, global: rows[0].global };
	}

	return {
		caps,
		day,
		/** What this user and everyone have spent today. */
		totals: (userId) => totals(userId),

		/** Why a call can't go ahead now, or null when one may (it may still be refused once sized). */
		async blocked(userId) {
			const t = await totals(userId);
			if (t.user >= caps.userUsd) return userCapped(caps.userUsd);
			if (t.global >= caps.globalUsd) return globalCapped();
			return null;
		},

		/**
		 * Reserves up to `maxUsd` for one call; returns the reservation's id.
		 * @throws {AllowanceError}
		 */
		async reserve(userId, maxUsd, model) {
			if (!(maxUsd >= 0) || !Number.isFinite(maxUsd))
				throw new Error('A reservation needs a cost.');
			return db.tx(async (c) => {
				await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
				const t = await totals(userId, c);
				if (t.user >= caps.userUsd || t.user + maxUsd > caps.userUsd)
					throw new AllowanceError(
						t.user >= caps.userUsd
							? userCapped(caps.userUsd)
							: `There isn’t enough of today’s free AI allowance left for this step (${usd(caps.userUsd - t.user)} of ${usd(caps.userUsd)}). It resets at 00:00 UTC; add your own key under Account to keep going.`,
						'user'
					);
				if (t.global >= caps.globalUsd || t.global + maxUsd > caps.globalUsd)
					throw new AllowanceError(globalCapped(), 'global');
				const { rows } = await c.query(
					`INSERT INTO ai_spend (user_id, day, state, reserved_usd, model) VALUES ($1, $2, 'reserved', $3, $4) RETURNING id`,
					[userId, t.day, maxUsd, model]
				);
				return rows[0].id;
			});
		},

		/** Settles a reservation at what the call cost. */
		async settle(id, { costUsd, promptTokens = null, outputTokens = null }) {
			await db.query(
				`UPDATE ai_spend SET state = 'settled', cost_usd = $2, prompt_tokens = $3, output_tokens = $4, settled_at = now()
				 WHERE id = $1 AND state = 'reserved'`,
				[id, Math.max(0, costUsd), promptTokens, outputTokens]
			);
		}
	};
}

function userCapped(cap) {
	return `You’ve used today’s free AI allowance (${usd(cap)}). It resets at 00:00 UTC; add your own key under Account to keep going.`;
}
function globalCapped() {
	return 'Today’s free AI budget for everyone is used up. It resets at 00:00 UTC; add your own key under Account to keep going.';
}
