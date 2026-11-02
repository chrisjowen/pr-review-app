import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAuth, parseCookies, safeNext } from '../src/auth.js';

const SECRET = 'a'.repeat(40);
const ORIGIN = 'https://pr.chrisjowen.net';
const reqWith = (cookies) => ({
	headers: {
		cookie: cookies
			.map((c) => c.split(';')[0])
			.filter(Boolean)
			.join('; ')
	}
});

/** A fake of GitHub's OAuth endpoints and GET /user. */
function fakeGitHub({
	token = 'gho_token',
	user = { id: 42, login: 'octo', name: 'Octo Cat' }
} = {}) {
	const calls = [];
	const fetch = async (url, init = {}) => {
		calls.push({ url: String(url), init });
		if (String(url) === 'https://github.example/login/oauth/access_token') {
			const body = JSON.parse(init.body);
			if (body.code !== 'good-code' || body.client_secret !== 'shh')
				return Response.json({ error: 'bad_verification_code' });
			return Response.json(token ? { access_token: token, token_type: 'bearer' } : {});
		}
		if (String(url) === 'https://api.github.example/user') {
			if (init.headers.authorization !== `Bearer ${token}`)
				return new Response('{}', { status: 401 });
			return Response.json(user);
		}
		return new Response('nope', { status: 404 });
	};
	return { fetch, calls };
}

const github = {
	clientId: 'Iv1.client',
	clientSecret: 'shh',
	oauthUrl: 'https://github.example',
	apiUrl: 'https://api.github.example'
};

describe('sessions', () => {
	const auth = createAuth({ secret: SECRET, origin: ORIGIN });
	const user = { id: 5, login: 'octo', name: 'Octo', kind: 'github' };

	it('names the signed-in user from a signed, secure, host-only cookie', () => {
		const c = auth.issue(user);
		assert.match(c, /^__Host-prs=/);
		assert.match(c, /HttpOnly/);
		assert.match(c, /Secure/);
		assert.match(c, /SameSite=Lax/);
		assert.match(c, /Path=\//);
		assert.ok(!/Domain=/i.test(c));
		assert.deepEqual(auth.user(reqWith([c])), user);
	});

	it('ignores a forged, altered or expired cookie', () => {
		const c = auth.issue(user).split(';')[0];
		const [name, value] = c.split('=');
		const [body, mac] = value.split('.');
		const forged = Buffer.from(JSON.stringify({ uid: 1, login: 'admin', exp: 9e9 })).toString(
			'base64url'
		);
		for (const bad of [
			`${forged}.${mac}`,
			`${body}.x${mac.slice(1)}`,
			`${body}`,
			`${body}.${mac}.x`
		])
			assert.equal(auth.user({ headers: { cookie: `${name}=${bad}` } }), null);
		const other = createAuth({ secret: 'b'.repeat(40), origin: ORIGIN });
		assert.equal(other.user(reqWith([auth.issue(user)])), null);
		let now = Date.now();
		const timed = createAuth({ secret: SECRET, origin: ORIGIN, now: () => now });
		const fresh = timed.issue(user);
		now += 8 * 24 * 3600 * 1000;
		assert.equal(timed.user(reqWith([fresh])), null);
	});

	it('signs out by clearing the cookie', () => {
		assert.match(auth.signOut(), /^__Host-prs=; .*Max-Age=0/);
	});

	it('uses a plain cookie name on http (local), without Secure', () => {
		const local = createAuth({ secret: SECRET, origin: 'http://localhost:8080' });
		const c = local.issue(user);
		assert.match(c, /^prs=/);
		assert.ok(!/Secure/.test(c));
	});

	it('needs a long secret', () => {
		assert.throws(() => createAuth({ secret: 'short', origin: ORIGIN }), /at least 32/);
	});

	it('reads cookies, skipping malformed ones', () => {
		assert.deepEqual(parseCookies('a=1; b=%E0%A4%A; c=x%20y'), { a: '1', c: 'x y' });
	});
});

describe('where to go after signing in', () => {
	it('keeps paths on this site', () => {
		for (const ok of ['/', '/o/r/pull/1/review', '/account?saved=1'])
			assert.equal(safeNext(ok), ok);
	});
	it('sends anything else home (no open redirect)', () => {
		for (const bad of [
			'//evil.example',
			'/\\evil.example',
			'\\\\evil.example',
			'https://evil.example',
			'evil.example',
			'/\tevil',
			'/ok\nLocation: x',
			'',
			null,
			42,
			'/' + 'a'.repeat(3000)
		])
			assert.equal(safeNext(bad), '/', String(bad));
	});
});

describe('the demo login', () => {
	it('is off unless asked for', () => {
		const auth = createAuth({ secret: SECRET, origin: 'http://localhost:8080' });
		assert.equal(auth.demo, false);
		assert.throws(() => auth.demoIdentity(), /off/);
	});
	it('is never on for an https site', () => {
		assert.throws(
			() => createAuth({ secret: SECRET, origin: ORIGIN, demo: true }),
			/local use only/
		);
	});
	it('makes a throwaway identity locally', () => {
		const auth = createAuth({ secret: SECRET, origin: 'http://localhost:8080', demo: true });
		const a = auth.demoIdentity();
		assert.equal(a.kind, 'demo');
		assert.equal(a.githubId, null);
		assert.notEqual(a.login, auth.demoIdentity().login);
	});
});

describe('Sign in with GitHub (OAuth App, identity only)', () => {
	it('is off without both the client id and secret', () => {
		const auth = createAuth({ secret: SECRET, origin: ORIGIN, github: { clientId: 'x' } });
		assert.equal(auth.github, false);
		assert.throws(() => auth.start('/'), /isn’t set up/);
	});

	it('signs in: authorise, call back, trade the code, ask who it is, keep no token', async () => {
		const gh = fakeGitHub();
		const auth = createAuth({ secret: SECRET, origin: ORIGIN, github, fetch: gh.fetch });
		const s = auth.start('/o/r/pull/1/review');
		const u = new URL(s.url);
		assert.equal(u.origin + u.pathname, 'https://github.example/login/oauth/authorize');
		assert.equal(u.searchParams.get('client_id'), 'Iv1.client');
		assert.equal(u.searchParams.get('redirect_uri'), `${ORIGIN}/auth/github/callback`);
		assert.equal(u.searchParams.get('scope'), null, 'asks for no scopes');
		assert.match(s.cookie, /^__Host-prs_oauth=.*Max-Age=600/);
		const state = u.searchParams.get('state');
		const done = await auth.finish(
			reqWith([s.cookie]),
			new URLSearchParams({ code: 'good-code', state })
		);
		assert.deepEqual(done.identity, {
			githubId: 42,
			login: 'octo',
			name: 'Octo Cat',
			kind: 'github'
		});
		assert.equal(done.next, '/o/r/pull/1/review');
		assert.match(done.clear, /Max-Age=0/);
		assert.equal(gh.calls.length, 2);
		assert.ok(!JSON.stringify(done).includes('gho_token'));
	});

	it('refuses a callback whose state isn’t this browser’s', async () => {
		const gh = fakeGitHub();
		const auth = createAuth({ secret: SECRET, origin: ORIGIN, github, fetch: gh.fetch });
		const s = auth.start('/');
		const state = new URL(s.url).searchParams.get('state');
		const q = (st) => new URLSearchParams({ code: 'good-code', state: st });
		await assert.rejects(
			auth.finish(reqWith([]), q(state)),
			/expired or came from another browser/
		);
		await assert.rejects(auth.finish(reqWith([s.cookie]), q('wrong')), /another browser/);
		const other = auth.start('/');
		await assert.rejects(auth.finish(reqWith([other.cookie]), q(state)), /another browser/);
		// A state cookie signed with another secret doesn't count.
		const forger = createAuth({ secret: 'z'.repeat(40), origin: ORIGIN, github });
		const f = forger.start('/');
		await assert.rejects(
			auth.finish(reqWith([f.cookie]), q(new URL(f.url).searchParams.get('state'))),
			/another browser/
		);
		assert.equal(gh.calls.length, 0, 'GitHub is never asked');
	});

	it('sanitises the saved next path (no open redirect through sign-in)', async () => {
		const gh = fakeGitHub();
		const auth = createAuth({ secret: SECRET, origin: ORIGIN, github, fetch: gh.fetch });
		const s = auth.start('//evil.example/x');
		const done = await auth.finish(
			reqWith([s.cookie]),
			new URLSearchParams({ code: 'good-code', state: new URL(s.url).searchParams.get('state') })
		);
		assert.equal(done.next, '/');
	});

	it('says so when GitHub refuses the code, or the sign-in was cancelled', async () => {
		const gh = fakeGitHub();
		const auth = createAuth({ secret: SECRET, origin: ORIGIN, github, fetch: gh.fetch });
		const s = auth.start('/');
		const state = new URL(s.url).searchParams.get('state');
		await assert.rejects(
			auth.finish(reqWith([s.cookie]), new URLSearchParams({ code: 'bad', state })),
			/didn’t sign you in/
		);
		await assert.rejects(
			auth.finish(reqWith([s.cookie]), new URLSearchParams({ error: 'access_denied', state })),
			/cancelled/
		);
		const noUser = fakeGitHub({ user: { message: 'Bad credentials' } });
		const a2 = createAuth({ secret: SECRET, origin: ORIGIN, github, fetch: noUser.fetch });
		const s2 = a2.start('/');
		await assert.rejects(
			a2.finish(
				reqWith([s2.cookie]),
				new URLSearchParams({ code: 'good-code', state: new URL(s2.url).searchParams.get('state') })
			),
			/didn’t say who you are/
		);
	});
});
