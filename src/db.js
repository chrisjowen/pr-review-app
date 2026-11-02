/**
 * The app's own Postgres: users, their sealed keys, their reviews and
 * prompts, the AI spend ledger and the shared answer cache. Migrations are the
 * numbered SQL files in `migrations/`, applied in order at start-up under an
 * advisory lock, each in its own transaction.
 */

import { readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
const LOCK = 7_301_942;

// numeric comes back as a string by default; sums of dollars are small enough for a double.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
// A `date` is a day, not a moment: keep it as YYYY-MM-DD.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/** @param {{ url: string; max?: number }} o */
export function createDb({ url, max = 10 }) {
	const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000 });
	pool.on('error', () => {
		// An idle client lost its connection; the pool replaces it on the next query.
	});
	return {
		pool,
		query: (text, params) => pool.query(text, params),
		/** Runs `fn` in one transaction, with the client to query on. */
		async tx(fn) {
			const client = await pool.connect();
			try {
				await client.query('BEGIN');
				const out = await fn(client);
				await client.query('COMMIT');
				return out;
			} catch (e) {
				await client.query('ROLLBACK').catch(() => {});
				throw e;
			} finally {
				client.release();
			}
		},
		async ping() {
			await pool.query('SELECT 1');
		},
		end: () => pool.end()
	};
}

/** Waits for Postgres to answer (it may be starting, or a new pod not yet let through the network policy). */
export async function waitFor(db, { tries = 60, delayMs = 1000, log = () => {} } = {}) {
	for (let i = 1; ; i++) {
		try {
			return await db.ping();
		} catch (e) {
			if (i >= tries) throw e;
			if (i === 1) log(`waiting for Postgres: ${e.message}`);
			await new Promise((r) => setTimeout(r, delayMs));
		}
	}
}

/** Applies any migration not yet applied; returns the names it applied. */
export async function migrate(db) {
	const files = readdirSync(MIGRATIONS)
		.filter((f) => /^\d+_[\w-]+\.sql$/.test(f))
		.sort();
	const client = await db.pool.connect();
	const applied = [];
	try {
		await client.query('SELECT pg_advisory_lock($1)', [LOCK]);
		await client.query(
			'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
		);
		const done = new Set(
			(await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name)
		);
		for (const f of files) {
			if (done.has(f)) continue;
			await client.query('BEGIN');
			try {
				await client.query(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
				await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
				await client.query('COMMIT');
				applied.push(f);
			} catch (e) {
				await client.query('ROLLBACK');
				throw new Error(`Migration ${f} failed: ${e.message}`, { cause: e });
			}
		}
	} finally {
		await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
		client.release();
	}
	return applied;
}
