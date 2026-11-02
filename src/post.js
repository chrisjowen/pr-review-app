/**
 * Posts a review the user confirmed to GitHub, as them, with the user token
 * they signed in with (renewed with its refresh token when a GitHub App's
 * token has expired). This is the shared engine's `github.post` for one user.
 *
 * GitHub's rules are met here rather than surfaced as failures:
 *
 * - nobody may approve or request changes on their own pull request, so that
 *   review goes up as a comment, and the result says so;
 * - an inline comment must sit on a line of the diff, so when GitHub refuses
 *   one, the comments go into the review's body with their file and lines.
 *
 * When the site's GitHub App can't write reviews (it lacks the Pull requests
 * permission, or isn't installed where the PR lives), the error says how to
 * fix it.
 */

import { GitHubError } from 'pr-review-wheelhouse/wheelhouse/engine/github.js';

const EARLY = 60_000;

export const OWN_PR_NOTE =
	'GitHub doesn’t let you approve or request changes on your own pull request, so this was posted as a comment.';
export const MOVED_NOTE =
	'GitHub wouldn’t take some comments on their lines, so they’re in the review’s body with their file and lines.';

/** A comment's place, as `path:from-to`. */
const where = (c) =>
	`${c.path}:${c.start_line && c.start_line < c.line ? `${c.start_line}-` : ''}${c.line}`;

/** The review's body with its inline comments listed under it. */
export function foldComments(body, comments) {
	if (!comments.length) return body;
	return [body, '', ...comments.map((c) => `- \`${where(c)}\`: ${c.body}`)].join('\n');
}

/**
 * @param {{
 *   users: ReturnType<typeof import('./users.js').createUsers>;
 *   auth: { refresh(refreshToken: string): Promise<any> };
 *   api?: string; appSlug?: string; fetch?: typeof fetch; now?: () => number;
 *   log?: (line: string) => void;
 * }} o
 */
export function createPoster({
	users,
	auth,
	api = 'https://api.github.com',
	appSlug = '',
	fetch: get = fetch,
	now = Date.now,
	log = () => {}
}) {
	const base = api.replace(/\/+$/, '');
	const signInAgain =
		'Sign out and sign in with GitHub again, then post. Until then, copy the review as Markdown.';

	/** The user's access token, renewed when it has (nearly) expired. */
	async function tokenFor(user) {
		if (user.kind !== 'github')
			throw new GitHubError(
				'The demo login can’t post to GitHub. Sign in with GitHub to post, or copy the review as Markdown.',
				403
			);
		const t = await users.githubToken(user.id);
		if (!t)
			throw new GitHubError(`This site has no GitHub sign-in to post with. ${signInAgain}`, 401);
		if (!t.expiresAt || t.expiresAt - EARLY > now()) return t.access;
		if (!t.refresh || (t.refreshExpiresAt && t.refreshExpiresAt <= now()))
			throw new GitHubError(`Your GitHub sign-in has expired. ${signInAgain}`, 401);
		let next;
		try {
			next = await auth.refresh(t.refresh);
		} catch (e) {
			log(`token refresh for user ${user.id} failed: ${e.message}`);
			throw new GitHubError(`GitHub didn’t renew your sign-in. ${signInAgain}`, 401);
		}
		await users.saveGithubToken(user.id, next);
		return next.access;
	}

	function cantWrite(pr) {
		const repo = `${pr.owner}/${pr.repo}`;
		const install = appSlug
			? ` Install it on ${pr.owner}: https://github.com/apps/${appSlug}/installations/new.`
			: '';
		return new GitHubError(
			`GitHub won’t let this site post reviews on ${repo} yet. Its GitHub App needs the “Pull requests: Read and write” permission (the App’s owner sets it under the App’s settings, Permissions), and it must be installed on ${repo}.${install} Then sign out and sign in again. Until then, copy the review as Markdown.`,
			403
		);
	}

	return {
		/**
		 * @param {{ id: number; login: string; kind: string }} user
		 * @param {{ owner: string; repo: string; number: number; url: string; headSha: string; author?: string }} pr
		 * @param {{ event: string; body: string; comments: any[] }} review
		 * @returns {Promise<{ url: string; id: number | null; event: string; note: string | null }>}
		 */
		async post(user, pr, { event, body, comments }) {
			const token = await tokenFor(user);
			const notes = [];
			let ev = event;
			let text = body;
			let inline = comments ?? [];
			if (ev !== 'COMMENT' && pr.author && pr.author.toLowerCase() === user.login.toLowerCase()) {
				ev = 'COMMENT';
				notes.push(OWN_PR_NOTE);
			}
			for (let attempt = 0; attempt < 3; attempt++) {
				const res = await get(`${base}/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, {
					method: 'POST',
					headers: {
						accept: 'application/vnd.github+json',
						authorization: `Bearer ${token}`,
						'content-type': 'application/json',
						'user-agent': 'pr-review-app',
						'x-github-api-version': '2022-11-28'
					},
					body: JSON.stringify({ commit_id: pr.headSha, event: ev, body: text, comments: inline }),
					signal: AbortSignal.timeout(20_000)
				});
				const out = await res.json().catch(() => ({}));
				if (res.ok)
					return {
						url: typeof out.html_url === 'string' ? out.html_url : pr.url,
						id: Number.isSafeInteger(out.id) ? out.id : null,
						event: ev,
						note: notes.length ? notes.join(' ') : null
					};
				const said = [out.message, ...(Array.isArray(out.errors) ? out.errors : [])]
					.map((e) => (typeof e === 'string' ? e : (e?.message ?? '')))
					.join(' ');
				if (res.status === 401) {
					await users.clearGithubToken(user.id).catch(() => {});
					throw new GitHubError(`GitHub no longer accepts your sign-in here. ${signInAgain}`, 401);
				}
				if (res.status === 403 && /rate limit/i.test(said))
					throw new GitHubError('GitHub’s rate limit is used up for now. Try again shortly.', 429);
				if (res.status === 403 || res.status === 404) throw cantWrite(pr);
				if (res.status === 422 && ev !== 'COMMENT' && /own pull request/i.test(said)) {
					ev = 'COMMENT';
					notes.push(OWN_PR_NOTE);
					continue;
				}
				if (res.status === 422 && inline.length && /line|position|path|diff/i.test(said)) {
					text = foldComments(text, inline);
					inline = [];
					notes.push(MOVED_NOTE);
					continue;
				}
				log(`posting to ${pr.url} failed: ${res.status} ${said}`);
				throw new GitHubError(
					`GitHub didn’t take the review (${res.status}${said.trim() ? `: ${said.trim().slice(0, 200)}` : ''}).`,
					502
				);
			}
			throw new GitHubError('GitHub didn’t take the review.', 502);
		}
	};
}
