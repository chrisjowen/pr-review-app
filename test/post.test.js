import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MOVED_NOTE, OWN_PR_NOTE, createPoster, foldComments } from '../src/post.js';

const PR = {
	owner: 'o',
	repo: 'r',
	number: 7,
	url: 'https://github.com/o/r/pull/7',
	headSha: 'abc1234',
	author: 'agent-bot'
};
const USER = { id: 5, login: 'octo', kind: 'github' };
const REVIEW = {
	event: 'REQUEST_CHANGES',
	body: 'Two changes requested; see the comments.',
	comments: [
		{ path: 'src/a.js', line: 12, side: 'RIGHT', body: '**Change requested:** Check the scope.' },
		{
			path: 'src/b.js',
			start_line: 3,
			start_side: 'RIGHT',
			line: 5,
			side: 'RIGHT',
			body: '**Suggestion:** Split this loop.'
		}
	]
};

/** A user store holding one token in memory. */
function fakeUsers(token) {
	let t = token;
	return {
		saved: () => t,
		async githubToken() {
			return t ?? null;
		},
		async saveGithubToken(_id, next) {
			t = next;
		},
		async clearGithubToken() {
			t = null;
		}
	};
}

/** GitHub's create-review endpoint, answering each call with the next of `answers`. */
function fakeGitHub(answers) {
	const calls = [];
	const fetch = async (url, init) => {
		calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
		const [status, json] = answers[Math.min(calls.length, answers.length) - 1];
		return Response.json(json, { status });
	};
	return { fetch, calls };
}

const posted = [201, { id: 99, html_url: 'https://github.com/o/r/pull/7#pullrequestreview-99' }];

describe('posting a review as the user', () => {
	it('posts the event, body and inline comments on the head commit with the user’s token', async () => {
		const gh = fakeGitHub([posted]);
		const poster = createPoster({
			users: fakeUsers({ access: 'ghu_live', expiresAt: null }),
			auth: { refresh: async () => assert.fail('no refresh needed') },
			api: 'https://api.github.example',
			fetch: gh.fetch
		});
		const done = await poster.post(USER, PR, REVIEW);
		assert.deepEqual(done, {
			url: 'https://github.com/o/r/pull/7#pullrequestreview-99',
			id: 99,
			event: 'REQUEST_CHANGES',
			note: null
		});
		assert.equal(gh.calls.length, 1);
		assert.equal(gh.calls[0].url, 'https://api.github.example/repos/o/r/pulls/7/reviews');
		assert.equal(gh.calls[0].headers.authorization, 'Bearer ghu_live');
		assert.deepEqual(gh.calls[0].body, {
			commit_id: 'abc1234',
			event: 'REQUEST_CHANGES',
			body: REVIEW.body,
			comments: REVIEW.comments
		});
	});

	it('posts a verdict on your own pull request as a comment, and says so', async () => {
		const gh = fakeGitHub([posted]);
		const poster = createPoster({
			users: fakeUsers({ access: 'ghu_live' }),
			auth: { refresh: async () => null },
			fetch: gh.fetch
		});
		const done = await poster.post({ ...USER, login: 'Agent-Bot' }, PR, {
			...REVIEW,
			event: 'APPROVE'
		});
		assert.equal(gh.calls[0].body.event, 'COMMENT');
		assert.equal(done.event, 'COMMENT');
		assert.equal(done.note, OWN_PR_NOTE);
	});

	it('falls back to a comment when GitHub says it’s your own pull request', async () => {
		const gh = fakeGitHub([
			[422, { message: 'Unprocessable Entity', errors: ['Can not approve your own pull request'] }],
			posted
		]);
		const poster = createPoster({
			users: fakeUsers({ access: 'ghu_live' }),
			auth: { refresh: async () => null },
			fetch: gh.fetch
		});
		const done = await poster.post(USER, PR, { ...REVIEW, event: 'APPROVE' });
		assert.deepEqual(
			gh.calls.map((c) => c.body.event),
			['APPROVE', 'COMMENT']
		);
		assert.equal(done.event, 'COMMENT');
		assert.equal(done.note, OWN_PR_NOTE);
	});

	it('moves comments GitHub won’t take inline into the body, with their file and lines', async () => {
		const gh = fakeGitHub([
			[422, { message: 'Unprocessable Entity', errors: ['Line could not be resolved'] }],
			posted
		]);
		const poster = createPoster({
			users: fakeUsers({ access: 'ghu_live' }),
			auth: { refresh: async () => null },
			fetch: gh.fetch
		});
		const done = await poster.post(USER, PR, REVIEW);
		const second = gh.calls[1].body;
		assert.deepEqual(second.comments, []);
		assert.equal(second.event, 'REQUEST_CHANGES');
		assert.match(second.body, /^Two changes requested/);
		assert.match(second.body, /- `src\/a\.js:12`: \*\*Change requested:\*\* Check the scope\./);
		assert.match(second.body, /- `src\/b\.js:3-5`: \*\*Suggestion:\*\* Split this loop\./);
		assert.equal(done.note, MOVED_NOTE);
	});

	it('says how to fix a GitHub App that can’t write reviews', async () => {
		for (const [status, json] of [
			[403, { message: 'Resource not accessible by integration' }],
			[404, { message: 'Not Found' }]
		]) {
			const gh = fakeGitHub([[status, json]]);
			const poster = createPoster({
				users: fakeUsers({ access: 'ghu_live' }),
				auth: { refresh: async () => null },
				appSlug: 'pr-review-humans',
				fetch: gh.fetch
			});
			await assert.rejects(poster.post(USER, PR, REVIEW), (e) => {
				assert.match(e.message, /Pull requests: Read and write/);
				assert.match(e.message, /installed on o\/r/);
				assert.match(e.message, /github\.com\/apps\/pr-review-humans\/installations\/new/);
				assert.match(e.message, /sign out and sign in again/);
				assert.match(e.message, /copy the review as Markdown/);
				return true;
			});
		}
	});

	it('renews an expired token with its refresh token, and keeps the new one', async () => {
		const now = 1_000_000;
		const users = fakeUsers({
			access: 'ghu_old',
			refresh: 'ghr_1',
			expiresAt: now + 30_000,
			refreshExpiresAt: now + 1e9
		});
		const gh = fakeGitHub([posted]);
		const refreshed = [];
		const poster = createPoster({
			users,
			auth: {
				async refresh(r) {
					refreshed.push(r);
					return { access: 'ghu_new', refresh: 'ghr_2', expiresAt: now + 8 * 3600e3 };
				}
			},
			fetch: gh.fetch,
			now: () => now
		});
		await poster.post(USER, PR, REVIEW);
		assert.deepEqual(refreshed, ['ghr_1']);
		assert.equal(gh.calls[0].headers.authorization, 'Bearer ghu_new');
		assert.equal(users.saved().access, 'ghu_new');
	});

	it('asks you to sign in again when there’s no token, it can’t be renewed, or GitHub drops it', async () => {
		const gh = fakeGitHub([posted]);
		const auth = { refresh: async () => Promise.reject(new Error('bad_refresh_token')) };
		const none = createPoster({ users: fakeUsers(null), auth, fetch: gh.fetch });
		await assert.rejects(none.post(USER, PR, REVIEW), /sign in with GitHub again/);
		const stale = createPoster({
			users: fakeUsers({ access: 'a', refresh: 'r', expiresAt: 1 }),
			auth,
			fetch: gh.fetch,
			now: () => 1e6
		});
		await assert.rejects(stale.post(USER, PR, REVIEW), /didn’t renew/);
		assert.equal(gh.calls.length, 0);
		const users = fakeUsers({ access: 'revoked' });
		const dropped = createPoster({
			users,
			auth,
			fetch: fakeGitHub([[401, { message: 'Bad credentials' }]]).fetch
		});
		await assert.rejects(dropped.post(USER, PR, REVIEW), /no longer accepts your sign-in/);
		assert.equal(users.saved(), null, 'the dead token is dropped');
	});

	it('never posts for a demo login', async () => {
		const gh = fakeGitHub([posted]);
		const poster = createPoster({
			users: fakeUsers({ access: 'x' }),
			auth: { refresh: async () => null },
			fetch: gh.fetch
		});
		await assert.rejects(
			poster.post({ id: 1, login: 'demo-abc', kind: 'demo' }, PR, REVIEW),
			/demo login can’t post/
		);
		assert.equal(gh.calls.length, 0);
	});

	it('lists comments under a body', () => {
		assert.equal(foldComments('Body.', []), 'Body.');
		assert.equal(
			foldComments('Body.', [{ path: 'x.js', line: 4, body: 'Hm.' }]),
			'Body.\n\n- `x.js:4`: Hm.'
		);
	});
});
