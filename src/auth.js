/**
 * Who is signed in: an HMAC-signed session cookie naming the user. Two ways in:
 *
 * - Sign in with GitHub, through a GitHub App's user authorization (or a
 *   classic OAuth App: the same web flow). Identity only: no scopes, and the
 *   user token is used once to ask who you are, then dropped, so it doesn't
 *   matter whether the App's user tokens expire or come with a refresh token.
 * - A demo login, for running the app on your own machine before a GitHub App
 *   exists. It is off unless PRREVIEW_DEMO_LOGIN=1, and never on with an https
 *   origin, so a deployed site can't mint throwaway identities.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const WEEK = 7 * 24 * 3600;
const b64 = (b) => Buffer.from(b).toString('base64url');

export function parseCookies(header = '') {
	const out = {};
	for (const part of String(header).split(';')) {
		const i = part.indexOf('=');
		if (i <= 0) continue;
		try {
			out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
		} catch {
			// a malformed cookie is no cookie
		}
	}
	return out;
}

/** A same-site path to go back to after signing in; anything else is home. */
export function safeNext(next) {
	return typeof next === 'string' &&
		next.length < 2000 &&
		/^\/(?![/\\])/.test(next) &&
		!/[\s\\]/.test(next) &&
		![...next].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
		? next
		: '/';
}

/**
 * @param {{
 *   secret: string; origin: string;
 *   github?: { clientId?: string; clientSecret?: string; oauthUrl?: string; apiUrl?: string };
 *   demo?: boolean; fetch?: typeof fetch; now?: () => number;
 * }} o
 */
export function createAuth({
	secret,
	origin,
	github = {},
	demo = false,
	fetch: get = fetch,
	now = Date.now
}) {
	if (!secret || secret.length < 32)
		throw new Error('PRREVIEW_SESSION_SECRET must be at least 32 characters.');
	const secure = origin.startsWith('https://');
	if (demo && secure)
		throw new Error('The demo login is for local use only; it can’t be on with an https origin.');
	const SESSION = secure ? '__Host-prs' : 'prs';
	const STATE = secure ? '__Host-prs_oauth' : 'prs_oauth';
	const oauthUrl = (github.oauthUrl || 'https://github.com').replace(/\/+$/, '');
	const apiUrl = (github.apiUrl || 'https://api.github.com').replace(/\/+$/, '');
	const callbackUrl = `${origin}/auth/github/callback`;
	const sign = (data) => createHmac('sha256', secret).update(data).digest('base64url');
	const cookie = (name, value, maxAge) =>
		`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
	const pack = (value) => {
		const body = b64(JSON.stringify(value));
		return `${body}.${sign(body)}`;
	};
	const unpack = (raw) => {
		const [body, mac, extra] = String(raw ?? '').split('.');
		if (!body || !mac || extra !== undefined) return null;
		const want = Buffer.from(sign(body));
		const got = Buffer.from(mac);
		if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
		try {
			const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
			return v && typeof v === 'object' && v.exp > now() / 1000 ? v : null;
		} catch {
			return null;
		}
	};
	const enabled = !!(github.clientId && github.clientSecret);

	return {
		github: enabled,
		demo,
		callbackUrl,

		/** The signed-in user, `{ id, login, name, kind }`, or null. */
		user(req) {
			const v = unpack(parseCookies(req.headers.cookie)[SESSION]);
			if (!v || !Number.isSafeInteger(v.uid) || typeof v.login !== 'string') return null;
			return { id: v.uid, login: v.login, name: String(v.name ?? v.login), kind: v.kind };
		},

		/** The session cookie for a user from the database. */
		issue(user) {
			return cookie(
				SESSION,
				pack({
					uid: user.id,
					login: user.login,
					name: user.name,
					kind: user.kind,
					exp: Math.floor(now() / 1000) + WEEK
				}),
				WEEK
			);
		},

		signOut: () => cookie(SESSION, '', 0),

		/** A throwaway identity for the demo login. */
		demoIdentity() {
			if (!demo) throw new Error('The demo login is off.');
			const tag = randomBytes(3).toString('hex');
			return { githubId: null, login: `demo-${tag}`, name: 'Demo reviewer', kind: 'demo' };
		},

		/** Where to send the browser to sign in, and the cookie tying the callback to it. */
		start(next) {
			if (!enabled) throw new Error('Sign in with GitHub isn’t set up here.');
			const state = b64(randomBytes(18));
			const url = new URL(`${oauthUrl}/login/oauth/authorize`);
			url.searchParams.set('client_id', github.clientId);
			url.searchParams.set('redirect_uri', callbackUrl);
			url.searchParams.set('state', state);
			url.searchParams.set('allow_signup', 'true');
			return {
				url: url.href,
				cookie: cookie(
					STATE,
					pack({ state, next: safeNext(next), exp: Math.floor(now() / 1000) + 600 }),
					600
				)
			};
		},

		/**
		 * Checks the callback against this browser's state, trades the code for a token,
		 * and asks GitHub who this is. The token isn't kept.
		 * @returns {Promise<{ identity: { githubId: number; login: string; name: string; kind: 'github' }; next: string; clear: string }>}
		 */
		async finish(req, query) {
			if (!enabled) throw new Error('Sign in with GitHub isn’t set up here.');
			const saved = unpack(parseCookies(req.headers.cookie)[STATE]);
			const state = query.get('state') ?? '';
			if (
				!saved ||
				typeof saved.state !== 'string' ||
				saved.state.length !== state.length ||
				!timingSafeEqual(Buffer.from(saved.state), Buffer.from(state))
			)
				throw new Error('That sign-in link expired or came from another browser. Try again.');
			const error = query.get('error');
			if (error === 'access_denied')
				throw new Error('GitHub sign-in was cancelled. You can try again any time.');
			if (error)
				throw new Error(
					`GitHub couldn’t sign you in (${error.replace(/[^\w-]/g, '').slice(0, 60)}). Try again.`
				);
			const code = query.get('code');
			if (!code) throw new Error('GitHub didn’t send a sign-in code. Try again.');
			const tokRes = await get(`${oauthUrl}/login/oauth/access_token`, {
				method: 'POST',
				headers: { accept: 'application/json', 'content-type': 'application/json' },
				body: JSON.stringify({
					client_id: github.clientId,
					client_secret: github.clientSecret,
					code,
					redirect_uri: callbackUrl
				}),
				signal: AbortSignal.timeout(15_000)
			});
			const tok = tokRes.ok ? await tokRes.json().catch(() => ({})) : {};
			if (typeof tok.access_token !== 'string' || !tok.access_token)
				throw new Error(
					tok.error === 'incorrect_client_credentials'
						? 'Sign in with GitHub is misconfigured on this site. Try again later.'
						: 'GitHub didn’t sign you in. Try again.'
				);
			const meRes = await get(`${apiUrl}/user`, {
				headers: {
					accept: 'application/vnd.github+json',
					authorization: `Bearer ${tok.access_token}`,
					'user-agent': 'pr-review-app'
				},
				signal: AbortSignal.timeout(15_000)
			});
			const me = meRes.ok ? await meRes.json().catch(() => null) : null;
			if (!Number.isSafeInteger(me?.id) || typeof me.login !== 'string')
				throw new Error('GitHub didn’t say who you are. Try again.');
			return {
				identity: {
					githubId: me.id,
					login: me.login,
					name: typeof me.name === 'string' && me.name ? me.name : me.login,
					kind: 'github'
				},
				next: safeNext(saved.next),
				clear: cookie(STATE, '', 0)
			};
		}
	};
}
