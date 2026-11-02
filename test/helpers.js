/**
 * Test helpers: a fresh Postgres database per test file (from
 * PRREVIEW_TEST_DATABASE_URL, an admin connection), fake OpenAI-compatible
 * answers, and a small unified diff.
 */

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, migrate } from '../src/db.js';

export const TEST_DB = process.env.PRREVIEW_TEST_DATABASE_URL ?? '';

/** Skips a database test locally when no test database is configured; CI always has one. */
export function dbOptions() {
	if (TEST_DB) return {};
	if (process.env.CI) throw new Error('PRREVIEW_TEST_DATABASE_URL must be set in CI.');
	return { skip: 'set PRREVIEW_TEST_DATABASE_URL to run the Postgres tests' };
}

/** A new, migrated database; `drop()` removes it. */
export async function freshDb() {
	const name = `prreview_test_${randomBytes(5).toString('hex')}`;
	const admin = new pg.Client({ connectionString: TEST_DB });
	await admin.connect();
	await admin.query(`CREATE DATABASE ${name}`);
	await admin.end();
	const url = new URL(TEST_DB);
	url.pathname = `/${name}`;
	const db = createDb({ url: url.href, max: 5 });
	await migrate(db);
	return {
		db,
		url: url.href,
		async drop() {
			await db.end();
			const a = new pg.Client({ connectionString: TEST_DB });
			await a.connect();
			await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
			await a.end();
		}
	};
}

export async function addUser(db, login = `u${randomBytes(3).toString('hex')}`) {
	const { rows } = await db.query(
		`INSERT INTO users (login, name, kind) VALUES ($1, $1, 'demo') RETURNING id`,
		[login]
	);
	return Number(rows[0].id);
}

/** An OpenAI-compatible streamed answer. */
export function sseAnswer(text, usage = { prompt_tokens: 100, completion_tokens: 50 }) {
	const chunks = [
		...text.match(/.{1,20}/gs).map((piece) => ({ choices: [{ delta: { content: piece } }] })),
		{ choices: [], usage }
	];
	const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A fake fetch for the AI provider that records each call and answers with `answer(body)`. */
export function fakeProvider(answer = () => '{"ok":true}') {
	const calls = [];
	const fetch = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push({ url: String(url), body, headers: init.headers });
		return sseAnswer(answer(body));
	};
	return { fetch, calls };
}

export const DIFF = `diff --git a/src/engine/core.js b/src/engine/core.js
index 1111111..2222222 100644
--- a/src/engine/core.js
+++ b/src/engine/core.js
@@ -1,3 +1,14 @@
 export function a() {
-  return 1;
+  return 2;
 }
+export function b() {
+  return 3;
+}
+export function c() {
+  return 4;
+}
+export function d() {
+  return 5;
+}
+// end
diff --git a/src/engine/util.js b/src/engine/util.js
index 1111111..2222222 100644
--- a/src/engine/util.js
+++ b/src/engine/util.js
@@ -1,2 +1,13 @@
-const x = 1;
+const x = 2;
+const y = 3;
+const z = 4;
+const w = 5;
+const v = 6;
+const u = 7;
+const t = 8;
+const s = 9;
+const r = 10;
+const q = 11;
+const p = 12;
 export default x;
diff --git a/test/core.test.js b/test/core.test.js
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/test/core.test.js
@@ -0,0 +1,2 @@
+import { a } from '../src/engine/core.js';
+a();
diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # x
+More words.
diff --git a/package.json b/package.json
index 1111111..2222222 100644
--- a/package.json
+++ b/package.json
@@ -1,3 +1,3 @@
 {
-  "version": "1.0.0"
+  "version": "1.0.1"
 }
diff --git a/package-lock.json b/package-lock.json
index 1111111..2222222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
 {
-  "lockfileVersion": 2
+  "lockfileVersion": 3
 }
diff --git a/src/tiny.js b/src/tiny.js
index 1111111..2222222 100644
--- a/src/tiny.js
+++ b/src/tiny.js
@@ -1 +1 @@
-export const tiny = 1;
+export const tiny = 2;
`;
