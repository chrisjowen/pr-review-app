/**
 * The site's routes:
 *
 *   /                                 the marketing page
 *   /go?url=…                         any PR URL → its page here
 *   /<owner>/<repo>/pull/<n>          a public PR's reading plan: no AI, no sign-in
 *   /<owner>/<repo>/pull/<n>/review   the guided review, as a chat (signed in; ?view=cards for the card tab)
 *   …/review/file?path=…              one changed file whole at the reviewed head, for the file drawer
 *   …/review/context                  the project as a whole: description, topics, the start of its README
 *   /engine/api/…                     the shared engine's API, for the signed-in user
 *   /signin, /auth/…                  sign in with GitHub (or the local demo login)
 *   /account                          the allowance, your own key, your data
 *   /healthz, /readyz                 liveness, and readiness (Postgres answers)
 */

import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubError } from 'pr-review-wheelhouse/wheelhouse/engine/github.js';
import { safeNext } from './auth.js';
import {
	accountPage,
	chatShell,
	errorPage,
	marketingPage,
	prPage,
	reviewShell,
	signinPage
} from './pages.js';
import { filesOf } from './plan.js';
import { PROVIDERS } from './reviewer.js';
import { githubUrl, matchPrPath, parsePrInput, prPath } from './urls.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = {
	'/static/': path.join(HERE, '..', 'static'),
	'/ui/': path.dirname(
		fileURLToPath(import.meta.resolve('pr-review-wheelhouse/wheelhouse/ui/index.js'))
	)
};
const TYPES = {
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml'
};
const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
	"font-src 'self' https://fonts.gstatic.com",
	"img-src 'self' https: data:",
	"connect-src 'self'",
	"frame-ancestors 'none'",
	"base-uri 'none'",
	"form-action 'self'",
	"object-src 'none'"
].join('; ');
const ROBOTS = 'User-agent: *\nDisallow: /engine/\nDisallow: /auth/\nDisallow: /account\n';

/**
 * @param {{
 *   origin: string; demoPr: string; caps: { userUsd: number; globalUsd: number }; aiOn: boolean;
 *   db: any; auth: any; users: any; spend: any; engines: any; github: any; seeds: any[];
 *   log?: (line: string) => void;
 * }} deps
 */
export function createApp({
	origin,
	demoPr,
	caps,
	aiOn,
	db,
	auth,
	users,
	spend,
	engines,
	github,
	seeds,
	log = () => {}
}) {
	const secure = origin.startsWith('https://');
	const host = new URL(origin).host;
	const seeded = new Set(seeds.map((r) => r.pr.url.toLowerCase()));
	const signin = auth.github || auth.demo;

	function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
		res.statusCode = status;
		res.setHeader('content-type', type);
		res.setHeader('content-security-policy', CSP);
		res.setHeader('x-content-type-options', 'nosniff');
		res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
		res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
		if (secure) res.setHeader('strict-transport-security', 'max-age=31536000');
		if (!extra['cache-control']) res.setHeader('cache-control', 'no-store');
		for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
		res.end(body);
	}
	const json = (res, status, v) =>
		send(res, status, JSON.stringify(v), 'application/json; charset=utf-8');
	const redirect = (res, to, cookies = []) => {
		res.statusCode = 303;
		if (cookies.length) res.setHeader('set-cookie', cookies);
		res.setHeader('location', to);
		res.setHeader('cache-control', 'no-store');
		res.end();
	};

	/** A browser form or fetch from this site, not another one. */
	function sameOrigin(req) {
		const o = req.headers.origin;
		if (o) return o === origin;
		return req.headers['sec-fetch-site'] === 'same-origin';
	}

	function readForm(req, max = 16 * 1024) {
		return new Promise((resolve, reject) => {
			let s = '';
			req.setEncoding('utf8');
			req.on('data', (c) => {
				s += c;
				if (s.length > max) {
					reject(new Error('That form is too large.'));
					req.destroy();
				}
			});
			req.on('end', () => resolve(new URLSearchParams(s)));
			req.on('error', reject);
		});
	}

	function serveStatic(res, pathname) {
		for (const [prefix, dir] of Object.entries(STATIC)) {
			if (!pathname.startsWith(prefix)) continue;
			const rel = pathname.slice(prefix.length);
			const type = TYPES[path.extname(rel)];
			let ok;
			try {
				ok = /^[\w-][\w.-]*$/.test(rel) && !!type && statSync(path.join(dir, rel)).isFile();
			} catch {
				ok = false;
			}
			if (!ok) {
				send(res, 404, 'Not found', 'text/plain; charset=utf-8');
				return true;
			}
			res.statusCode = 200;
			res.setHeader('content-type', type);
			res.setHeader('cache-control', 'no-cache');
			res.setHeader('x-content-type-options', 'nosniff');
			createReadStream(path.join(dir, rel))
				.on('error', () => {
					if (!res.headersSent) res.statusCode = 404;
					res.end();
				})
				.pipe(res);
			return true;
		}
		return false;
	}

	/** The signed-in user, checked against the database (a session can outlive a wiped database). */
	async function signedIn(req) {
		const u = auth.user(req);
		if (!u) return null;
		return (await users.exists(u.id)) ? u : null;
	}

	async function aiStatus(user) {
		const own = await users.keyInfo(user.id);
		const t = await spend.totals(user.id);
		const ctx = await engines.get(user);
		return {
			reviewer: ctx.reviewer.name,
			own,
			aiOn,
			spent: t.user,
			globalSpent: t.global,
			caps
		};
	}

	async function prRoute(req, res, user, at, url) {
		const { owner, repo, number, suffix } = at;
		const ghUrl = githubUrl(at);
		const here = prPath(at);
		if (suffix === 'review' && at.part) {
			if (!user) return json(res, 401, { error: 'Sign in to review.' });
			return reviewPartRoute(res, user, at, url);
		}
		if (suffix === 'review') {
			if (!user) return redirect(res, `/signin?next=${encodeURIComponent(`${here}/review`)}`);
			const s = await aiStatus(user);
			const ctx = await engines.get(user);
			const note = s.own
				? `Your ${s.own.label} key`
				: aiOn
					? `Free allowance: $${s.spent.toFixed(2)} of $${caps.userUsd.toFixed(2)} used today`
					: 'Live AI is off: the demo reviews are pre-generated';
			const shell = { user, origin, pr: { owner, repo, number, url: ghUrl }, note };
			// The chat is the review; the card tab stays a click away, with its prompt settings.
			return send(
				res,
				200,
				url.searchParams.get('view') === 'cards'
					? reviewShell({ ...shell, settings: ctx.settings() })
					: chatShell({ ...shell, live: !!s.own || aiOn })
			);
		}
		if (suffix) return redirect(res, here);
		try {
			const { pr, diff, checksKnown } = await github.basics(owner, repo, number);
			return send(
				res,
				200,
				prPage({
					user,
					origin,
					pr,
					files: filesOf(diff),
					checksKnown,
					demo: seeded.has(String(pr.url).toLowerCase()),
					signin,
					limit: github.limit()
				}),
				undefined,
				{ 'cache-control': 'private, no-cache' }
			);
		} catch (e) {
			const status = e instanceof GitHubError ? e.status : 500;
			if (status >= 500) log(`pr page ${ghUrl} failed: ${e?.stack || e}`);
			return send(
				res,
				status,
				errorPage({
					user,
					origin,
					status,
					message:
						status >= 500 && !(e instanceof GitHubError)
							? 'Something went wrong reading that pull request.'
							: e.message,
					ghUrl
				})
			);
		}
	}

	/**
	 * What the chat review reads besides the engine: one of the PR's changed
	 * files whole at the head the user's review was made at (`file`), so it
	 * lines up with the review's diff, or the project as a whole (`context`).
	 * Only files that review changes are read, so this is never a proxy for the
	 * rest of GitHub.
	 */
	async function reviewPartRoute(res, user, { owner, repo, number, part }, url) {
		try {
			if (part === 'context') return json(res, 200, await github.project(owner, repo));
			const path = url.searchParams.get('path') ?? '';
			const ctx = await engines.get(user);
			let kept;
			try {
				kept = ctx.reviews.view(`${owner}__${repo}__${number}`);
			} catch {
				kept = null;
			}
			if (!kept) return json(res, 404, { error: 'Open the review of this pull request first.' });
			if (!kept.files.some((f) => f.path === path))
				return json(res, 404, { error: 'That file isn’t part of this pull request.' });
			const sha = kept.pr.headSha;
			const text = await github.file(owner, repo, sha, path);
			if (text === null)
				return json(res, 404, {
					error: 'That file isn’t there at the PR’s head (it was deleted).'
				});
			return json(res, 200, { path, sha, text });
		} catch (e) {
			const status = e instanceof GitHubError ? e.status : 500;
			if (status >= 500)
				log(`review ${part} for ${owner}/${repo}#${number} failed: ${e?.stack || e}`);
			return json(res, status, {
				error: e instanceof GitHubError ? e.message : 'Something went wrong reading that.'
			});
		}
	}

	/** The shared engine's API, for the signed-in user only, as if on loopback. */
	async function engineRoute(req, res, user, url) {
		if (!user) return json(res, 401, { error: 'Sign in to review.' });
		const method = req.method ?? 'GET';
		if (method !== 'GET' && !sameOrigin(req))
			return json(res, 403, { error: 'Requests must come from this site.' });
		const api = url.pathname.slice('/engine'.length);
		const ctx = await engines.get(user);
		// Anything that calls the model (a re-run, a chat question, starting over) is refused up
		// front when the reviewer can't run now (no live AI, or the allowance is spent), so a kept
		// review is never thrown away for nothing and the reason shows at once.
		const callsModel =
			(method === 'POST' && /^\/api\/reviews\/[\w.-]+\/run$/.test(api)) ||
			(method === 'POST' && /^\/api\/reviews\/[\w.-]+\/ask$/.test(api)) ||
			(method === 'DELETE' && /^\/api\/reviews\/[\w.-]+$/.test(api));
		if (callsModel) {
			const ok = await ctx.reviewer.check();
			if (!ok.ok) return json(res, 409, { error: ok.reason });
		}
		req.url = api + url.search;
		req.headers.host = '127.0.0.1';
		delete req.headers.origin;
		return ctx.handler(req, res);
	}

	async function accountRoute(req, res, user, url, p, method) {
		if (!user) return redirect(res, '/signin?next=/account');
		const page = async (extra) =>
			accountPage({ user, origin, status: await aiStatus(user), providers: PROVIDERS, ...extra });
		if (method === 'GET' && p === '/account')
			return send(res, 200, await page({ saved: url.searchParams.get('saved') }));
		if (method !== 'POST') return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
		if (!sameOrigin(req)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
		const form = await readForm(req);
		let saved;
		try {
			if (p === '/account/key') {
				await users.saveKey(user.id, {
					provider: form.get('provider'),
					key: form.get('key'),
					model: form.get('model')
				});
				saved = 'Key saved.';
			} else if (p === '/account/key/clear') {
				await users.clearKey(user.id);
				saved = 'Key removed.';
			} else if (p === '/account/forget') {
				await engines.drop(user.id);
				await users.forget(user.id);
				saved = 'Your reviews, prompts and key are deleted.';
			} else return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
		} catch (e) {
			return send(res, 400, await page({ error: e.message }));
		}
		if (p !== '/account/forget') await (await engines.get(user)).refresh();
		return redirect(res, `/account?saved=${encodeURIComponent(saved)}`);
	}

	async function handle(req, res) {
		const url = new URL(req.url ?? '/', origin);
		const p = url.pathname;
		const method = req.method ?? 'GET';

		if (p === '/healthz') return send(res, 200, 'ok', 'text/plain; charset=utf-8');
		if (p === '/readyz') {
			try {
				await db.ping();
				return send(res, 200, 'ok', 'text/plain; charset=utf-8');
			} catch {
				return send(res, 503, 'database unavailable', 'text/plain; charset=utf-8');
			}
		}
		if (p === '/robots.txt') return send(res, 200, ROBOTS, 'text/plain; charset=utf-8');
		if (method === 'GET' && serveStatic(res, p)) return;

		const user = await signedIn(req);
		if (p.startsWith('/engine/')) return engineRoute(req, res, user, url);

		if (method === 'GET' && p === '/')
			return send(res, 200, marketingPage({ user, origin, demo: demoPr, caps, aiOn }));
		if (method === 'GET' && p === '/go') {
			const at = parsePrInput(url.searchParams.get('url') ?? '', host);
			return at
				? redirect(res, prPath(at))
				: send(
						res,
						400,
						errorPage({
							user,
							origin,
							status: 400,
							message:
								'That isn’t a GitHub pull request URL. It should look like https://github.com/owner/repo/pull/123.'
						})
					);
		}

		if (method === 'GET' && p === '/signin') {
			const next = safeNext(url.searchParams.get('next'));
			if (user) return redirect(res, next);
			return send(
				res,
				200,
				signinPage({ user, origin, next, github: auth.github, demo: auth.demo })
			);
		}
		if (method === 'POST' && p === '/auth/demo') {
			if (!auth.demo) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
			if (!sameOrigin(req)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
			const form = await readForm(req);
			const u = await users.upsert(auth.demoIdentity());
			return redirect(res, safeNext(form.get('next')), [auth.issue(u)]);
		}
		if (method === 'GET' && p === '/auth/github') {
			if (!auth.github) return redirect(res, '/signin');
			const s = auth.start(url.searchParams.get('next'));
			return redirect(res, s.url, [s.cookie]);
		}
		if (method === 'GET' && p === '/auth/github/callback') {
			let done;
			try {
				done = await auth.finish(req, url.searchParams);
			} catch (e) {
				return send(
					res,
					400,
					signinPage({
						user: null,
						origin,
						next: '/',
						github: auth.github,
						demo: auth.demo,
						error: e.message
					})
				);
			}
			const u = await users.upsert(done.identity);
			await users.saveGithubToken(u.id, done.token);
			log(`signed in: user ${u.id} (${u.login})`);
			return redirect(res, done.next, [auth.issue(u), done.clear]);
		}
		if (method === 'POST' && p === '/auth/signout') {
			if (!sameOrigin(req)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
			if (user) await users.clearGithubToken(user.id);
			return redirect(res, '/', [auth.signOut()]);
		}

		if (p === '/account' || p.startsWith('/account/'))
			return accountRoute(req, res, user, url, p, method);

		const at = matchPrPath(p);
		if (method === 'GET' && at) return prRoute(req, res, user, at, url);

		return send(
			res,
			404,
			errorPage({
				user,
				origin,
				status: 404,
				message:
					'There’s nothing at this address. Try a pull request: swap github.com for this site in its URL.'
			})
		);
	}

	return {
		/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
		async handle(req, res) {
			try {
				await handle(req, res);
			} catch (e) {
				log(`request ${req.method} ${req.url} failed: ${e?.stack || e}`);
				if (!res.headersSent) send(res, 500, 'Something went wrong.', 'text/plain; charset=utf-8');
				else res.end();
			}
		}
	};
}
