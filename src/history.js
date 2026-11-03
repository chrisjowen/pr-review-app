/**
 * The reviews already done, read back from Postgres for the pages: a user's
 * own reviews (home and the account page) and the reviews of one pull request
 * posted to GitHub from this site (the PR page). A review is summed up the way
 * the chat files its cards: how many changes it has, how many the reviewer
 * has decided, and how many it likes, notes, thinks need work or finds
 * serious. Another user's review shows only once it's posted, as GitHub shows
 * it to everyone anyway.
 */

import { allCards, CARD_VERDICTS } from 'pr-review-wheelhouse/wheelhouse/ui/cards.js';
import { partKind, verdictTable } from '../static/chat-core.js';

const vt = verdictTable(CARD_VERDICTS);

/** What a summary reads: the review without its diff, chat threads and requests, and whether it has chat. */
const SLIM = `review - 'files' - 'chat' - 'requests' AS review,
	coalesce(review->'chat', '{}'::jsonb) <> '{}'::jsonb AS chatted`;

/** One kept review, summed up. */
export function summarize(review) {
	const pr = review.pr ?? {};
	const cards = allCards(review);
	const decisions = review.cardDecisions ?? {};
	const parts = { like: 0, note: 0, work: 0, serious: 0 };
	for (const c of cards) parts[partKind(c.verdict, vt)]++;
	return {
		id: review.id,
		owner: pr.owner,
		repo: pr.repo,
		number: pr.number,
		title: pr.title ?? '',
		url: pr.url,
		headSha: pr.headSha ?? '',
		updatedAt: review.updatedAt ?? null,
		cards: cards.length,
		decided: cards.filter((c) => decisions[c.id]).length,
		parts,
		posted: review.posted ?? null
	};
}

/** @param {{ db: any; seeds?: any[] }} o */
export function createHistory({ db, seeds = [] }) {
	const seeded = new Set(seeds.map((r) => r.id));
	// A demo review is the site's until the user works on it: decides a change, asks about one, or posts it.
	// (Its copy may come from an older seed file, so nothing about the copy itself says it's untouched.)
	const theirs = ({ review, chatted }) =>
		!seeded.has(review.id) ||
		chatted ||
		!!review.posted ||
		Object.keys(review.cardDecisions ?? {}).length > 0;

	return {
		/** A user's reviews, the latest first. */
		async mine(userId, { limit = 50 } = {}) {
			const { rows } = await db.query(
				`SELECT ${SLIM} FROM reviews WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
				[userId, limit + seeded.size]
			);
			return rows
				.filter(theirs)
				.slice(0, limit)
				.map((r) => summarize(r.review));
		},

		/** A user's review of one pull request (by the engine's id), or null. */
		async mineOf(userId, id) {
			const { rows } = await db.query(
				`SELECT ${SLIM} FROM reviews WHERE user_id = $1 AND id = $2`,
				[userId, id]
			);
			return rows[0] && theirs(rows[0]) ? summarize(rows[0].review) : null;
		},

		/** The reviews of one pull request posted to GitHub from this site, the latest first. */
		async posted(id, { limit = 20 } = {}) {
			const { rows } = await db.query(
				`SELECT u.login, r.review->'posted' AS posted, r.review->'pr'->>'headSha' AS head
				 FROM reviews r JOIN users u ON u.id = r.user_id
				 WHERE r.id = $1 AND jsonb_typeof(r.review->'posted') = 'object'
				 ORDER BY r.updated_at DESC
				 LIMIT $2`,
				[id, limit]
			);
			return rows.map((r) => ({ login: r.login, headSha: r.head ?? '', ...r.posted }));
		}
	};
}
