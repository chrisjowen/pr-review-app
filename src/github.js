/**
 * Reads public pull requests over GitHub's REST API (no `gh`, no user token),
 * in the shape the shared engine's own reader gives, so the engine reviews
 * them unchanged. The diff comes from github.com's `.diff` view, which doesn't
 * count against the API's rate limit; the PR, its checks and (for a review)
 * its commits are a few API calls, cached for a minute and a half, and kept
 * stale to fall back on when GitHub's rate limit runs out.
 *
 * Without PRREVIEW_GITHUB_TOKEN the server shares GitHub's unauthenticated
 * limit of 60 API calls an hour; a fine-grained token with public read-only
 * access raises that to 5,000.
 */

import {
	GitHubError,
	checkState,
	imagesOf,
	parsePrUrl
} from 'pr-review-wheelhouse/wheelhouse/engine/github.js';

const NAME = /^[\w.-]{1,100}$/;
const MAX_DIFF = 20 * 1024 * 1024;
/** The most of one file, or of a README, the review's file drawer and context will read. */
const MAX_FILE = 1024 * 1024;
const SHA = /^[0-9a-f]{7,40}$/i;

/** A small TTL cache that keeps stale entries to fall back on when GitHub says no. */
function cache(max) {
	const m = new Map();
	return {
		get(k, ttl) {
			const e = m.get(k);
			return e ? { value: e.value, fresh: Date.now() - e.at < ttl } : null;
		},
		set(k, value) {
			m.delete(k);
			m.set(k, { value, at: Date.now() });
			while (m.size > max) m.delete(m.keys().next().value);
			return value;
		}
	};
}

export class RateLimited extends GitHubError {
	constructor(reset) {
		const at = reset ? new Date(reset * 1000) : null;
		super(
			`GitHub’s rate limit for this site is used up${at ? ` until ${at.toISOString().slice(11, 16)} UTC` : ''}. Try again then, or open the pull request on GitHub.`,
			429
		);
		this.reset = at;
	}
}

/**
 * @param {{ token?: string; fetch?: typeof fetch; ttlMs?: number; log?: (s: string) => void; api?: string; web?: string }} o
 */
export function createGitHubReader({
	token = '',
	fetch: get = fetch,
	ttlMs = 90_000,
	log = () => {},
	api = 'https://api.github.com',
	web = 'https://github.com',
	raw = 'https://raw.githubusercontent.com'
} = {}) {
	const meta = cache(500);
	const diffs = cache(60);
	const texts = cache(200);
	const headers = {
		'user-agent': 'pr-review-app',
		'x-github-api-version': '2022-11-28',
		...(token ? { authorization: `Bearer ${token}` } : {})
	};
	let limit = { remaining: null, reset: null };

	async function call(path, accept = 'application/vnd.github+json') {
		const res = await get(`${api}${path}`, {
			headers: { ...headers, accept },
			signal: AbortSignal.timeout(20_000)
		});
		const remaining = res.headers.get('x-ratelimit-remaining');
		if (remaining !== null)
			limit = { remaining: Number(remaining), reset: Number(res.headers.get('x-ratelimit-reset')) };
		if ((res.status === 403 || res.status === 429) && limit.remaining === 0)
			throw new RateLimited(limit.reset);
		if (res.status === 404)
			throw new GitHubError('GitHub couldn’t find that pull request, or it isn’t public.', 404);
		if (!res.ok) throw new GitHubError(`GitHub answered ${res.status}.`, 502);
		return res.json();
	}

	/** Fresh from the cache, else from GitHub, else stale from the cache when GitHub refuses. */
	async function cached(store, key, ttl, load) {
		const hit = store.get(key, ttl);
		if (hit?.fresh) return hit.value;
		try {
			return store.set(key, await load());
		} catch (e) {
			if (hit && e instanceof RateLimited) {
				log(`rate limited; serving stale ${key}`);
				return hit.value;
			}
			throw e;
		}
	}

	function check(owner, repo, number) {
		if (!NAME.test(owner) || !NAME.test(repo) || !Number.isSafeInteger(number) || number < 1)
			throw new GitHubError('That isn’t a GitHub pull request address.', 400);
		return `${owner}/${repo}#${number}`.toLowerCase();
	}

	/** The PR, with GitHub's own sanitised HTML of its description. */
	const pull = (owner, repo, number) =>
		cached(meta, `pull:${check(owner, repo, number)}`, ttlMs, () =>
			call(`/repos/${owner}/${repo}/pulls/${number}`, 'application/vnd.github.full+json')
		);

	const checksOf = (owner, repo, sha) =>
		cached(meta, `checks:${owner}/${repo}@${sha}`.toLowerCase(), ttlMs, async () => {
			const [runs, status] = await Promise.all([
				call(`/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`),
				call(`/repos/${owner}/${repo}/commits/${sha}/status`)
			]);
			const out = (runs.check_runs ?? []).map((c) => ({
				name: String(c.name ?? 'check'),
				state: checkState({ conclusion: c.conclusion, status: c.status }),
				url: typeof c.html_url === 'string' ? c.html_url : null
			}));
			for (const s of status.statuses ?? [])
				out.push({
					name: String(s.context ?? 'status'),
					state: checkState({ state: s.state }),
					url: typeof s.target_url === 'string' ? s.target_url : null
				});
			return out;
		});

	/** The unified diff, one per head, kept. */
	const diffOf = (owner, repo, number, sha) =>
		cached(diffs, `diff:${owner}/${repo}#${number}@${sha}`.toLowerCase(), Infinity, async () => {
			const res = await get(`${web}/${owner}/${repo}/pull/${number}.diff`, {
				headers: { 'user-agent': headers['user-agent'] },
				redirect: 'follow',
				signal: AbortSignal.timeout(60_000)
			});
			if (!res.ok) throw new GitHubError(`GitHub answered ${res.status} for the diff.`, 502);
			if (Number(res.headers.get('content-length') ?? 0) > MAX_DIFF)
				throw new GitHubError('That pull request’s diff is too big to read here.', 413);
			const text = await res.text();
			if (text.length > MAX_DIFF)
				throw new GitHubError('That pull request’s diff is too big to read here.', 413);
			return text;
		});

	const commitsOf = (owner, repo, number, sha) =>
		cached(meta, `commits:${owner}/${repo}#${number}@${sha}`.toLowerCase(), Infinity, async () =>
			(await call(`/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`)).map((c) => ({
				sha: String(c.sha ?? ''),
				msg: String(c.commit?.message ?? '').split('\n')[0]
			}))
		);

	/** Text from github.com's raw host (not rate limited), capped; null when it isn't there. */
	async function rawText(url) {
		const res = await get(url, {
			headers: { 'user-agent': headers['user-agent'] },
			redirect: 'follow',
			signal: AbortSignal.timeout(20_000)
		});
		if (res.status === 404) return null;
		if (!res.ok) throw new GitHubError(`GitHub answered ${res.status} for that file.`, 502);
		if (Number(res.headers.get('content-length') ?? 0) > MAX_FILE)
			throw new GitHubError('That file is too big to show here.', 413);
		const text = await res.text();
		if (text.length > MAX_FILE) throw new GitHubError('That file is too big to show here.', 413);
		return text;
	}

	const shape = (p, owner, repo, checks, commits = []) => ({
		owner,
		repo,
		number: p.number,
		url: p.html_url,
		title: String(p.title ?? ''),
		body: String(p.body ?? ''),
		bodyHtml: String(p.body_html ?? ''),
		author: p.user?.login ?? '',
		state: p.merged_at ? 'merged' : String(p.state ?? '').toLowerCase(),
		isDraft: !!p.draft,
		baseRef: p.base?.ref ?? '',
		headRef: p.head?.ref ?? '',
		headSha: p.head?.sha ?? '',
		additions: p.additions ?? 0,
		deletions: p.deletions ?? 0,
		changedFiles: p.changed_files ?? 0,
		createdAt: p.created_at ?? null,
		commits,
		checks,
		images: imagesOf(p.body)
	});

	return {
		limit: () => limit,

		/** What the public page shows: the PR, its checks and its diff (no commits: one call fewer). */
		async basics(owner, repo, number) {
			const p = await pull(owner, repo, number);
			const sha = p.head?.sha ?? '';
			const [checks, diff] = await Promise.all([
				checksOf(owner, repo, sha).catch((e) => {
					if (e instanceof RateLimited) return null;
					throw e;
				}),
				diffOf(owner, repo, number, sha)
			]);
			return { pr: shape(p, owner, repo, checks ?? []), diff, checksKnown: checks !== null };
		},

		/** The engine's `load(url)`: everything, commits too. */
		async load(url) {
			const at = parsePrUrl(url);
			if (!at) throw new GitHubError('That isn’t a GitHub pull request URL.', 400);
			const { owner, repo, number } = at;
			const p = await pull(owner, repo, number);
			const sha = p.head?.sha ?? '';
			const [checks, commits, diff] = await Promise.all([
				checksOf(owner, repo, sha).catch(() => []),
				commitsOf(owner, repo, number, sha).catch(() => []),
				diffOf(owner, repo, number, sha)
			]);
			const pr = shape(p, owner, repo, checks, commits);
			delete pr.bodyHtml;
			return { pr, diff };
		},

		/**
		 * One file as it is at a commit, for the review's file drawer: its text,
		 * or null when the file isn't there (deleted at that commit).
		 */
		async file(owner, repo, sha, path) {
			if (!NAME.test(owner) || !NAME.test(repo) || !SHA.test(sha))
				throw new GitHubError('That isn’t a file in a pull request.', 400);
			const clean = String(path ?? '');
			if (
				!clean ||
				clean.length > 1000 ||
				clean.split('/').some((p) => !p || p === '.' || p === '..')
			)
				throw new GitHubError('That isn’t a file in a pull request.', 400);
			const enc = clean.split('/').map(encodeURIComponent).join('/');
			return cached(
				texts,
				`file:${owner}/${repo}@${sha}`.toLowerCase() + `:${clean}`,
				Infinity,
				() => rawText(`${raw}/${owner}/${repo}/${sha}/${enc}`)
			);
		},

		/**
		 * What the review says about the project as a whole: the repository's
		 * description, language and topics, and the start of its README.
		 */
		async project(owner, repo) {
			if (!NAME.test(owner) || !NAME.test(repo))
				throw new GitHubError('That isn’t a GitHub repository.', 400);
			const r = await cached(meta, `repo:${owner}/${repo}`.toLowerCase(), 60 * 60_000, () =>
				call(`/repos/${owner}/${repo}`)
			);
			const branch = String(r.default_branch ?? 'main');
			let readme = null;
			for (const name of ['README.md', 'readme.md', 'README']) {
				readme = await cached(
					texts,
					`readme:${owner}/${repo}@${branch}`.toLowerCase() + `:${name}`,
					60 * 60_000,
					() => rawText(`${raw}/${owner}/${repo}/${encodeURIComponent(branch)}/${name}`)
				).catch(() => null);
				if (readme !== null) break;
			}
			return {
				repo: `${owner}/${repo}`,
				url: String(r.html_url ?? `${web}/${owner}/${repo}`),
				description: String(r.description ?? ''),
				language: r.language ? String(r.language) : null,
				topics: Array.isArray(r.topics) ? r.topics.map(String).slice(0, 12) : [],
				stars: Number(r.stargazers_count ?? 0),
				branch,
				readme: readme === null ? null : readme.slice(0, 6000)
			};
		},

		/** The site itself never posts: a review goes up as its user, through post.js. */
		async post() {
			throw new GitHubError(
				'This site doesn’t post to GitHub. Copy the review as Markdown and paste it into the pull request.',
				403
			);
		}
	};
}
