/**
 * The shared engine's store interface (synchronous: `review(id)`,
 * `saveReview(r)`, `prompts()` and the rest) for one user, over Postgres. A
 * user's reviews and prompts are read once when their engine starts and kept
 * in memory; writes land in memory at once and reach Postgres a moment later,
 * coalesced per review, so a burst of saves is one write. `flush()` writes
 * everything outstanding (the engine pool calls it before letting a user's
 * engine go, and on shutdown).
 */

/**
 * @param {ReturnType<typeof import('./db.js').createDb>} db
 * @param {number} userId
 * @param {{ delayMs?: number; log?: (line: string) => void }} [o]
 */
export async function loadStore(db, userId, { delayMs = 800, log = () => {} } = {}) {
	const reviews = new Map();
	for (const row of (await db.query('SELECT id, review FROM reviews WHERE user_id = $1', [userId]))
		.rows)
		reviews.set(row.id, row.review);
	let prompts =
		(await db.query('SELECT prompts FROM user_prompts WHERE user_id = $1', [userId])).rows[0]
			?.prompts ?? null;

	/** id → 'save' | 'delete' */
	const dirty = new Map();
	let promptsDirty = false;
	let timer = null;
	let flushing = null;
	let failures = 0;
	let discarded = false;
	const copy = (v) => (v === null || v === undefined ? null : structuredClone(v));

	function schedule(ms = delayMs) {
		if (timer || flushing || discarded) return;
		timer = setTimeout(() => {
			timer = null;
			void flush();
		}, ms);
		timer.unref?.();
	}

	async function writeOut() {
		const batch = [...dirty];
		dirty.clear();
		const withPrompts = promptsDirty;
		promptsDirty = false;
		try {
			for (const [id, what] of batch) {
				if (what === 'delete')
					await db.query('DELETE FROM reviews WHERE user_id = $1 AND id = $2', [userId, id]);
				else if (reviews.has(id))
					await db.query(
						`INSERT INTO reviews (user_id, id, review, updated_at) VALUES ($1, $2, $3, now())
						 ON CONFLICT (user_id, id) DO UPDATE SET review = EXCLUDED.review, updated_at = now()`,
						[userId, id, JSON.stringify(reviews.get(id))]
					);
			}
			if (withPrompts)
				await db.query(
					`INSERT INTO user_prompts (user_id, prompts, updated_at) VALUES ($1, $2, now())
					 ON CONFLICT (user_id) DO UPDATE SET prompts = EXCLUDED.prompts, updated_at = now()`,
					[userId, JSON.stringify(prompts ?? {})]
				);
			failures = 0;
		} catch (e) {
			// Put back what didn't land (a newer change for the same id wins), and try again later.
			for (const [id, what] of batch) if (!dirty.has(id)) dirty.set(id, what);
			promptsDirty ||= withPrompts;
			failures++;
			log(`store write for user ${userId} failed (${failures}): ${e.message}`);
			throw e;
		}
	}

	/** Writes everything outstanding; resolves when it has landed. */
	async function flush() {
		if (discarded) return;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		while (flushing) await flushing.catch(() => {});
		if (!dirty.size && !promptsDirty) return;
		flushing = writeOut();
		try {
			await flushing;
		} catch {
			flushing = null;
			schedule(Math.min(60_000, delayMs * 2 ** failures));
			return;
		}
		flushing = null;
		if (dirty.size || promptsDirty) schedule();
	}

	return {
		dir: null,
		prompts: () => copy(prompts),
		savePrompts(p) {
			prompts = copy(p);
			promptsDirty = true;
			schedule();
		},
		review: (id) => copy(reviews.get(id)),
		saveReview(r) {
			reviews.set(r.id, copy(r));
			dirty.set(r.id, 'save');
			schedule();
		},
		removeReview(id) {
			reviews.delete(id);
			dirty.set(id, 'delete');
			schedule();
		},
		reviewIds: () => [...reviews.keys()],
		/** Adds a review only if this user has none by that id (the demo reviews). */
		seed(r) {
			if (reviews.has(r.id)) return false;
			this.saveReview(r);
			return true;
		},
		flush,
		pending: () => dirty.size + (promptsDirty ? 1 : 0),
		/** Drops everything not yet written, and writes nothing from now on (the user's data was deleted). */
		async discard() {
			discarded = true;
			if (timer) clearTimeout(timer);
			timer = null;
			dirty.clear();
			promptsDirty = false;
			await flushing?.catch(() => {});
		}
	};
}
