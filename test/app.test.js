/**
 * The whole site over HTTP, against a real Postgres, a fake GitHub (its
 * OAuth endpoints and the PR reader) and a fake AI provider.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { createEngines } from '../src/engines.js';
import { createPoster } from '../src/post.js';
import { pgCache } from '../src/reviewer.js';
import { createSealer } from '../src/seal.js';
import { createSpend } from '../src/spend.js';
import { createUsers } from '../src/users.js';
import { DIFF, dbOptions, fakeProvider, freshDb } from './helpers.js';

const PR = {
	owner: 'o',
	repo: 'r',
	number: 7,
	url: 'https://github.com/o/r/pull/7',
	title: 'Teach the engine new tricks',
	body: 'Adds b, c and d.',
	bodyHtml: '<p>Adds b, c and d.</p>',
	author: 'agent',
	state: 'open',
	isDraft: false,
	baseRef: 'main',
	headRef: 'feat',
	headSha: 'abc1234def',
	additions: 30,
	deletions: 5,
	changedFiles: 7,
	commits: [],
	checks: [{ name: 'ci', state: 'pass', url: 'https://ci.example/1' }],
	images: []
};

const fakeReader = {
	limit: () => ({ remaining: null }),
	async basics(owner, repo, number) {
		if (number !== 7) {
			const { GitHubError } = await import('pr-review-wheelhouse/wheelhouse/engine/github.js');
			throw new GitHubError('GitHub couldn’t find that pull request, or it isn’t public.', 404);
		}
		return { pr: PR, diff: DIFF, checksKnown: true };
	},
	async load() {
		const { bodyHtml, ...pr } = PR;
		void bodyHtml;
		return { pr, diff: DIFF };
	},
	async post() {
		throw new Error('never');
	},
	/** Files at a head, as the raw host gives them: null when the file isn't there. */
	files: new Map([['src/engine/core.js', 'export function a() {\n  return 2;\n}\n']]),
	fileCalls: [],
	async file(owner, repo, sha, path) {
		this.fileCalls.push({ owner, repo, sha, path });
		return this.files.get(path) ?? null;
	},
	async project(owner, repo) {
		return {
			repo: `${owner}/${repo}`,
			url: `https://github.com/${owner}/${repo}`,
			description: 'A repo of tricks.',
			language: 'JavaScript',
			topics: ['tricks'],
			stars: 3,
			branch: 'main',
			readme: '# r\n\nIt does tricks.'
		};
	}
};

/** Each stage's answer, by what the prompt asks for. */
function answer(body) {
	const all = body.messages.map((m) => m.content).join('\n');
	if (!body.max_tokens || body.max_tokens < 1000) return 'A chat answer.';
	if (/walkthrough/i.test(all))
		return JSON.stringify({
			summary: 'It adds three functions.',
			why: 'More tricks.',
			stops: [{ title: 'The engine', files: ['src/engine/core.js'], why: 'The core change.' }]
		});
	return JSON.stringify({ findings: [], notes: [], files: [], summary: 'ok' });
}

/** Reviews posted to the fake GitHub. */
const posted = [];

function fakeOAuth() {
	return async (url, init = {}) => {
		const u = String(url);
		if (u === 'https://api.github.example/repos/o/r/pulls/7/reviews') {
			posted.push({ authorization: init.headers.authorization, body: JSON.parse(init.body) });
			return Response.json(
				{ id: 1, html_url: 'https://github.com/o/r/pull/7#pullrequestreview-1' },
				{ status: 201 }
			);
		}
		if (u === 'https://github.example/login/oauth/access_token') {
			const { code } = JSON.parse(init.body);
			return Response.json({ access_token: `tok-${code}` });
		}
		if (u === 'https://api.github.example/user') {
			const code = init.headers.authorization.replace('Bearer tok-', '');
			return Response.json({
				id: code === 'second' ? 1001 : 1000,
				login: `octo-${code}`,
				name: ''
			});
		}
		return new Response('', { status: 404 });
	};
}

describe('the site', dbOptions(), () => {
	let t, server, base, provider, engines, db;
	const ORIGIN = 'http://localhost:9';
	before(async () => {
		t = await freshDb();
		db = t.db;
		provider = fakeProvider(answer);
		const auth = createAuth({
			secret: randomBytes(32).toString('hex'),
			origin: ORIGIN,
			github: {
				clientId: 'cid',
				clientSecret: 'csecret',
				oauthUrl: 'https://github.example',
				apiUrl: 'https://api.github.example'
			},
			fetch: fakeOAuth()
		});
		const users = createUsers({ db, sealer: createSealer(randomBytes(32)) });
		const poster = createPoster({
			users,
			auth,
			api: 'https://api.github.example',
			fetch: fakeOAuth()
		});
		const caps = { userUsd: 0.05, globalUsd: 10 };
		const spend = createSpend({ db, caps });
		engines = createEngines({
			db,
			users,
			spend,
			cache: pgCache(db),
			github: fakeReader,
			poster,
			ai: {
				baseUrl: 'https://openrouter.example/api/v1',
				apiKey: 'server-key',
				model: 'cheap/model',
				label: 'Cheap model',
				priceIn: 1,
				priceOut: 2,
				maxTokens: { json: 2000, chat: 500 }
			},
			seeds: [],
			version: 'test',
			fetch: provider.fetch
		});
		const app = createApp({
			origin: ORIGIN,
			demoPr: 'https://github.com/chrisjowen/docket/pull/48',
			caps,
			aiOn: true,
			db,
			auth,
			users,
			spend,
			engines,
			github: fakeReader,
			seeds: []
		});
		server = createServer((req, res) => void app.handle(req, res));
		await new Promise((r) => server.listen(0, '127.0.0.1', r));
		base = `http://127.0.0.1:${server.address().port}`;
	});
	after(async () => {
		await engines?.close();
		server?.close();
		await t?.drop();
	});

	const get = (path, o = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...o });
	const cookieOf = (res) =>
		res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.filter((c) => !c.endsWith('='))
			.join('; ');
	const same = { origin: ORIGIN, 'x-pr-review': '1', 'content-type': 'application/json' };

	async function signIn(code = 'first', next = '/o/r/pull/7/review') {
		const start = await get(`/auth/github?next=${encodeURIComponent(next)}`);
		assert.equal(start.status, 303);
		const to = new URL(start.headers.get('location'));
		assert.equal(to.origin, 'https://github.example');
		const back = await get(
			`/auth/github/callback?code=${code}&state=${to.searchParams.get('state')}`,
			{ headers: { cookie: cookieOf(start) } }
		);
		assert.equal(back.status, 303);
		assert.equal(back.headers.get('location'), next);
		return cookieOf(back);
	}

	it('serves the marketing page and health checks', async () => {
		const res = await get('/');
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /PR review for <span class="hl">humans<\/span>/);
		assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
		assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
		assert.match(
			html,
			/<video src="\/static\/home-demo\.mp4"[^>]* autoplay muted loop playsinline/
		);
		for (const shot of ['overview', 'change', 'file', 'files', 'finish'])
			assert.match(html, new RegExp(`src="/static/home-${shot}\\.png"`));
		assert.ok(!/id="mine-h"/.test(html), 'nobody signed in, so no reviews of theirs');
		assert.equal((await get('/healthz')).status, 200);
		assert.equal((await get('/readyz')).status, 200);
		assert.equal((await get('/ui/index.js')).status, 200);
		assert.equal((await get('/ui/../package.json')).status, 404);
		assert.equal((await get('/static/%2e%2e%2fpackage.json')).status, 404);
	});

	it('serves the demo video in byte ranges, as Safari asks for it', async () => {
		const whole = await get('/static/home-demo.mp4');
		assert.equal(whole.status, 200);
		assert.equal(whole.headers.get('content-type'), 'video/mp4');
		assert.equal(whole.headers.get('accept-ranges'), 'bytes');
		const size = (await whole.arrayBuffer()).byteLength;
		assert.equal(Number(whole.headers.get('content-length')), size);
		const first = await get('/static/home-demo.mp4', { headers: { range: 'bytes=0-1' } });
		assert.equal(first.status, 206);
		assert.equal(first.headers.get('content-range'), `bytes 0-1/${size}`);
		assert.equal((await first.arrayBuffer()).byteLength, 2);
		const tail = await get('/static/home-demo.mp4', { headers: { range: 'bytes=-10' } });
		assert.equal(tail.headers.get('content-range'), `bytes ${size - 10}-${size - 1}/${size}`);
		assert.equal((await tail.arrayBuffer()).byteLength, 10);
		const past = await get('/static/home-demo.mp4', { headers: { range: `bytes=${size}-` } });
		assert.equal(past.status, 416);
		assert.equal(past.headers.get('content-range'), `bytes */${size}`);
	});

	it('swaps a pasted github.com URL for the page here', async () => {
		const res = await get(`/go?url=${encodeURIComponent('https://github.com/o/r/pull/7/files')}`);
		assert.equal(res.status, 303);
		assert.equal(res.headers.get('location'), '/o/r/pull/7');
		assert.equal((await get('/go?url=https%3A%2F%2Fevil.example%2Fo%2Fr%2Fpull%2F7')).status, 400);
		const tab = await get('/o/r/pull/7/files/abc');
		assert.equal(tab.headers.get('location'), '/o/r/pull/7');
	});

	it('shows any public PR’s reading plan with no sign-in and no AI', async () => {
		const before = provider.calls.length;
		const res = await get('/o/r/pull/7');
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /Teach the engine new tricks/);
		assert.match(html, /Read first<\/span> 1 stop, 2 files/);
		// The guided review's call to action comes first, above the PR's details, and says it needs sign-in.
		const cta = html.indexOf('Review it with a second pair of eyes');
		assert.ok(cta > 0 && cta < html.indexOf('<h2>Description</h2>'));
		assert.match(html, /href="\/signin\?next=%2Fo%2Fr%2Fpull%2F7%2Freview">Sign in to review →/);
		assert.match(html, /Reviewing needs you to sign in/);
		assert.match(html, /Reviews posted from here/);
		assert.equal(provider.calls.length, before, 'the basics never call the model');
		const missing = await get('/o/r/pull/8');
		assert.equal(missing.status, 404);
		assert.match(await missing.text(), /couldn’t find that pull request/);
	});

	it('needs sign-in to review', async () => {
		const res = await get('/o/r/pull/7/review');
		assert.equal(res.status, 303);
		assert.equal(res.headers.get('location'), '/signin?next=%2Fo%2Fr%2Fpull%2F7%2Freview');
		assert.equal((await get('/engine/api/status')).status, 401);
		assert.equal((await get('/account')).status, 303);
		const demo = await get('/auth/demo', {
			method: 'POST',
			headers: { origin: ORIGIN },
			body: 'next=/'
		});
		assert.equal(demo.status, 404, 'no demo login unless asked for');
		const signin = await (await get('/signin')).text();
		assert.match(signin, /Sign in with GitHub/);
		assert.ok(!/demo reviewer/.test(signin));
	});

	it('signs in with GitHub, keeping one user per GitHub account', async () => {
		const cookie = await signIn('first');
		const again = await signIn('first');
		const { rows } = await db.query('SELECT id, github_id, login, kind FROM users ORDER BY id');
		assert.equal(rows.length, 1);
		assert.equal(Number(rows[0].github_id), 1000);
		assert.equal(rows[0].kind, 'github');
		const page = await get('/o/r/pull/7/review', { headers: { cookie } });
		assert.equal(page.status, 200);
		assert.match(await page.text(), /Free allowance: \$0\.00 of \$0\.05 used today/);
		assert.equal((await get('/engine/api/status', { headers: { cookie: again } })).status, 200);
	});

	it('serves the guided review as a chat, with the card tab a click away', async () => {
		const cookie = await signIn('first');
		const chat = await get('/o/r/pull/7/review', { headers: { cookie } });
		assert.equal(chat.status, 200);
		const html = await chat.text();
		assert.match(html, /id="chatapp"/);
		assert.match(html, /data-pr="https:\/\/github\.com\/o\/r\/pull\/7"/);
		assert.match(html, /data-live="1"/);
		assert.match(html, /<script type="module" src="\/static\/chat\.js\?v=/);
		assert.match(html, /href="\/o\/r\/pull\/7\/review\?view=cards">Card view/);
		assert.ok(!/review\.js/.test(html));
		const cards = await (
			await get('/o/r/pull/7/review?view=cards', { headers: { cookie } })
		).text();
		assert.match(cards, /\/static\/review\.js/);
		assert.match(cards, /Chat review/);
		for (const asset of [
			'/static/chat.js',
			'/static/chat-core.js',
			'/static/chat.css',
			'/ui/draft.js',
			'/ui/cards.js'
		])
			assert.equal((await get(asset)).status, 200, asset);
	});

	it('reads a changed file whole at the reviewed head, and the project, for the chat review only', async () => {
		const cookie = await signIn('first');
		const headers = { cookie };
		assert.equal((await get('/o/r/pull/7/review/file?path=src/engine/core.js')).status, 401);
		assert.equal((await get('/o/r/pull/7/review/context')).status, 401);
		const unopened = await get('/o/r/pull/7/review/file?path=src/engine/core.js', { headers });
		assert.equal(unopened.status, 404);
		assert.match((await unopened.json()).error, /Open the review/);
		const opened = await get('/engine/api/reviews', {
			method: 'POST',
			headers: { ...same, cookie },
			body: JSON.stringify({ url: PR.url })
		});
		const { id } = await opened.json();
		for (let i = 0; i < 100; i++) {
			const r = await (await get(`/engine/api/reviews/${id}`, { headers })).json();
			if (!Object.values(r.runs).some((x) => x.state === 'queued' || x.state === 'running')) break;
			await new Promise((res) => setTimeout(res, 20));
		}
		// The author pushes again: the drawer still reads the head the review's diff came from.
		const reviewed = PR.headSha;
		PR.headSha = 'fff9999aaa';
		let ok;
		try {
			ok = await get('/o/r/pull/7/review/file?path=src/engine/core.js', { headers });
		} finally {
			PR.headSha = reviewed;
		}
		assert.equal(ok.status, 200);
		assert.deepEqual(await ok.json(), {
			path: 'src/engine/core.js',
			sha: reviewed,
			text: 'export function a() {\n  return 2;\n}\n'
		});
		assert.deepEqual(fakeReader.fileCalls.at(-1), {
			owner: 'o',
			repo: 'r',
			sha: reviewed,
			path: 'src/engine/core.js'
		});
		// Only the PR's own files: never a proxy for the rest of GitHub.
		const calls = fakeReader.fileCalls.length;
		const other = await get('/o/r/pull/7/review/file?path=secrets/.env', { headers });
		assert.equal(other.status, 404);
		assert.match((await other.json()).error, /isn’t part of this pull request/);
		assert.equal(fakeReader.fileCalls.length, calls);
		const gone = await get('/o/r/pull/7/review/file?path=src/engine/util.js', { headers });
		assert.equal(gone.status, 404);
		assert.match((await gone.json()).error, /deleted/);
		const ctx = await get('/o/r/pull/7/review/context', { headers });
		assert.equal(ctx.status, 200);
		assert.equal((await ctx.json()).description, 'A repo of tricks.');
		assert.equal((await get('/o/r/pull/7/review/other', { headers })).status, 404);
		// Opening the review cached its stage answers for everyone; the metered test needs a cold cache.
		await db.query('DELETE FROM ai_cache');
	});

	it('refuses a bad callback', async () => {
		const res = await get('/auth/github/callback?code=x&state=forged');
		assert.equal(res.status, 400);
		assert.match(await res.text(), /expired or came from another browser/);
	});

	it('runs a guided review on the free allowance, metered, and refuses once it is spent', async () => {
		const cookie = await signIn('second', '/');
		const headers = { ...same, cookie };
		const before = provider.calls.length;
		// Changes need this site's own origin.
		const cross = await get('/engine/api/reviews', {
			method: 'POST',
			headers: { ...headers, origin: 'https://evil.example' },
			body: JSON.stringify({ url: PR.url })
		});
		assert.equal(cross.status, 403);
		const opened = await get('/engine/api/reviews', {
			method: 'POST',
			headers,
			body: JSON.stringify({ url: PR.url })
		});
		assert.equal(opened.status, 200);
		const { id } = await opened.json();
		let r;
		for (let i = 0; i < 100; i++) {
			r = await (await get(`/engine/api/reviews/${id}`, { headers: { cookie } })).json();
			if (!Object.values(r.runs).some((x) => x.state === 'queued' || x.state === 'running')) break;
			await new Promise((res) => setTimeout(res, 20));
		}
		assert.equal(r.runs.walkthrough.state, 'done');
		assert.ok(provider.calls.length > before);
		const { rows } = await db.query(
			`SELECT count(*)::int AS n, sum(cost_usd)::float AS usd FROM ai_spend s JOIN users u ON u.id = s.user_id WHERE u.github_id = 1001`
		);
		assert.ok(rows[0].n >= 1);
		// Spend the rest of today's allowance, then ask a question: refused before any call.
		const user = (await db.query('SELECT id FROM users WHERE github_id = 1001')).rows[0].id;
		await db.query(
			`INSERT INTO ai_spend (user_id, day, state, reserved_usd, cost_usd, model) VALUES ($1, $2, 'settled', 1, 1, 'x')`,
			[user, new Date().toISOString().slice(0, 10)]
		);
		const calls = provider.calls.length;
		const ask = await get(`/engine/api/reviews/${id}/ask`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ stage: 'walkthrough', text: 'Why?' })
		});
		assert.equal(ask.status, 409);
		assert.match((await ask.json()).error, /used today’s free AI allowance/);
		const rerun = await get(`/engine/api/reviews/${id}/run`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ stage: 'walkthrough' })
		});
		assert.equal(rerun.status, 409);
		assert.equal(provider.calls.length, calls);
		// Posting to GitHub goes up as the signed-in user, only once they confirm, and costs no AI.
		const { rows: tokens } = await db.query(
			'SELECT sealed FROM user_github_tokens WHERE user_id = $1',
			[user]
		);
		assert.equal(tokens.length, 1);
		assert.ok(!tokens[0].sealed.includes('tok-second'), 'the token is sealed');
		const unconfirmed = await get(`/engine/api/reviews/${id}/post`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ event: 'COMMENT' })
		});
		assert.equal(unconfirmed.status, 400);
		assert.equal(posted.length, 0);
		const post = await get(`/engine/api/reviews/${id}/post`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ confirm: true, event: 'COMMENT', body: 'Thanks!' })
		});
		assert.equal(post.status, 200);
		assert.equal(
			(await post.json()).posted.url,
			'https://github.com/o/r/pull/7#pullrequestreview-1'
		);
		assert.equal(posted.length, 1);
		// A review goes up once: posting it again is refused before GitHub is asked.
		const again = await get(`/engine/api/reviews/${id}/post`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ confirm: true, event: 'APPROVE', body: 'Again' })
		});
		assert.equal(again.status, 409);
		assert.match((await again.json()).error, /already posted/);
		assert.equal(posted.length, 1);
		const listed = await (await get('/engine/api/reviews', { headers: { cookie } })).json();
		const kept = listed.reviews.find((x) => x.id === id);
		assert.equal(kept.posted.url, 'https://github.com/o/r/pull/7#pullrequestreview-1');
		assert.equal(kept.decided, 0);
		assert.equal(posted[0].authorization, 'Bearer tok-second');
		assert.equal(posted[0].body.event, 'COMMENT');
		assert.equal(posted[0].body.body, 'Thanks!');
		assert.equal(posted[0].body.commit_id, PR.headSha);
		assert.equal(provider.calls.length, calls);
		// Signing out drops the token; posting then asks you to sign in again.
		const out = await get('/auth/signout', { method: 'POST', headers: { origin: ORIGIN, cookie } });
		assert.equal(out.status, 303);
		assert.equal(
			(await db.query('SELECT 1 FROM user_github_tokens WHERE user_id = $1', [user])).rowCount,
			0
		);
	});

	it('shows the reviews already done: yours, and the ones posted from here', async () => {
		const cookie = await signIn('second', '/');
		// The posted review reaches Postgres a moment after it's posted.
		await new Promise((r) => setTimeout(r, 1000));
		// Anyone sees a review posted to GitHub from here, with who posted it, its verdict and a link.
		const pr = await (await get('/o/r/pull/7')).text();
		assert.match(pr, /<b>octo-second<\/b> <span class="posted COMMENT">Commented<\/span>/);
		assert.match(pr, /href="https:\/\/github\.com\/o\/r\/pull\/7#pullrequestreview-1"/);
		assert.ok(!/Your review/.test(pr));
		// Its reviewer sees their own review too, and goes back to it from the top of the page.
		const mine = await (await get('/o/r/pull/7', { headers: { cookie } })).text();
		assert.match(mine, /<b>Your review:<\/b> 0 of \d+ changes? decided/);
		assert.match(mine, /href="\/o\/r\/pull\/7\/review">Open your review →/);
		// Someone else who hasn't reviewed it (any more) starts one.
		const first = await signIn('first', '/');
		await get('/account/forget', { method: 'POST', headers: { origin: ORIGIN, cookie: first } });
		const theirs = await (await get('/o/r/pull/7', { headers: { cookie: first } })).text();
		assert.match(theirs, /Start the guided review →/);
		// Home and the account page list your reviews, each linking back to it.
		const home = await (await get('/', { headers: { cookie } })).text();
		assert.match(home, /id="mine-h">Your reviews/);
		assert.match(
			home,
			/class="rv-title" href="\/o\/r\/pull\/7\/review">Teach the engine new tricks/
		);
		const account = await (await get('/account', { headers: { cookie } })).text();
		assert.match(account, /id="reviews"/);
		assert.match(account, /href="\/o\/r\/pull\/7\/review"/);
		assert.match(account, /Commented<\/span>/);
	});

	it('keeps a user’s own key sealed, and reviews with it unmetered', async () => {
		const cookie = await signIn('first', '/');
		const KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789';
		const saved = await get('/account/key', {
			method: 'POST',
			headers: { origin: ORIGIN, cookie, 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ provider: 'openrouter', key: KEY, model: 'any/model' }).toString()
		});
		assert.equal(saved.status, 303);
		const { rows } = await db.query('SELECT provider, model, sealed FROM user_keys');
		assert.equal(rows.length, 1);
		assert.ok(!rows[0].sealed.includes(KEY));
		assert.ok(!rows[0].sealed.includes('abcdefghij'));
		const account = await (await get('/account', { headers: { cookie } })).text();
		assert.match(account, /any\/model \(your OpenRouter key\)/);
		assert.ok(!account.includes(KEY));
		const status = await (await get('/engine/api/status', { headers: { cookie } })).json();
		assert.equal(status.config.where, 'on your key');
		const bad = await get('/account/key', {
			method: 'POST',
			headers: { origin: ORIGIN, cookie, 'content-type': 'application/x-www-form-urlencoded' },
			body: 'provider=evil&key=x'
		});
		assert.equal(bad.status, 400);
		const cross = await get('/account/key/clear', {
			method: 'POST',
			headers: { origin: 'https://evil.example', cookie }
		});
		assert.equal(cross.status, 403);
		await get('/account/key/clear', { method: 'POST', headers: { origin: ORIGIN, cookie } });
		assert.equal((await db.query('SELECT 1 FROM user_keys')).rowCount, 0);
	});

	it('asks afresh only for the stage the user chose to read again', async () => {
		const cookie = await signIn('first', '/');
		const headers = { ...same, cookie };
		const settle = async (id) => {
			let r;
			for (let i = 0; i < 100; i++) {
				r = await (await get(`/engine/api/reviews/${id}`, { headers: { cookie } })).json();
				if (!Object.values(r.runs).some((x) => x.state === 'queued' || x.state === 'running'))
					return r;
				await new Promise((res) => setTimeout(res, 20));
			}
			return r;
		};
		const opened = await get('/engine/api/reviews', {
			method: 'POST',
			headers,
			body: JSON.stringify({ url: PR.url })
		});
		const { id } = await opened.json();
		await settle(id);
		const calls = provider.calls.length;
		// A run the engine turns down asks nothing afresh: starting over is all cached answers.
		const bad = await get(`/engine/api/reviews/${id}/run`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ stage: 'no-such-stage' })
		});
		assert.equal(bad.status, 404);
		const restarted = await get(`/engine/api/reviews/${id}`, { method: 'DELETE', headers });
		assert.equal(restarted.status, 200);
		assert.equal((await settle(id)).runs.walkthrough.state, 'done');
		assert.equal(provider.calls.length, calls);
		// "Read again" asks the model, once, for that stage.
		const again = await get(`/engine/api/reviews/${id}/run`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ stage: 'walkthrough' })
		});
		assert.equal(again.status, 200);
		const r = await settle(id);
		assert.equal(r.runs.walkthrough.state, 'done');
		assert.equal(provider.calls.length, calls + 1);
	});

	it('forgets a user’s reviews and key on request, but not their spend', async () => {
		const cookie = await signIn('second', '/');
		const user = (await db.query('SELECT id FROM users WHERE github_id = 1001')).rows[0].id;
		await new Promise((r) => setTimeout(r, 1000));
		assert.ok((await db.query('SELECT 1 FROM reviews WHERE user_id = $1', [user])).rowCount > 0);
		const res = await get('/account/forget', {
			method: 'POST',
			headers: { origin: ORIGIN, cookie }
		});
		assert.equal(res.status, 303);
		await new Promise((r) => setTimeout(r, 1000));
		assert.equal((await db.query('SELECT 1 FROM reviews WHERE user_id = $1', [user])).rowCount, 0);
		assert.ok((await db.query('SELECT 1 FROM ai_spend WHERE user_id = $1', [user])).rowCount > 0);
	});

	it('signs out only from this site', async () => {
		const cookie = await signIn('first', '/');
		const cross = await get('/auth/signout', {
			method: 'POST',
			headers: { origin: 'https://evil.example', cookie }
		});
		assert.equal(cross.status, 403);
		const out = await get('/auth/signout', { method: 'POST', headers: { origin: ORIGIN, cookie } });
		assert.equal(out.status, 303);
		assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
	});
});
