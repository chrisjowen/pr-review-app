/**
 * The URL swap: every GitHub pull request URL has a twin here with the same
 * path, so `https://github.com/<owner>/<repo>/pull/<n>` reads at
 * `<origin>/<owner>/<repo>/pull/<n>`. GitHub's own tabs on a PR (`/files`,
 * `/commits`, `/checks`, with anything after them) land on the PR page;
 * `/review` is the guided review, and `/review/file` and `/review/context`
 * are what it reads besides the engine (a changed file whole, and the project).
 */

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';
const REPO = '[\\w.-]{1,100}';
const PATH = new RegExp(
	`^/(${OWNER})/(${REPO})/pull/(\\d{1,9})(?:/(review|files|commits|checks)(/[^?#]*)?)?/?$`
);
const INPUT = new RegExp(
	`^(?:https?://)?(?:www\\.)?([\\w.-]+)/(${OWNER})/(${REPO})/pull/(\\d{1,9})(?:[/?#].*)?$`,
	'i'
);
const SHORT = new RegExp(`^(${OWNER})/(${REPO})#(\\d{1,9})$`);

const okRepo = (repo) => repo !== '.' && repo !== '..' && !repo.endsWith('.git');
const okNumber = (n) => Number.isSafeInteger(n) && n >= 1;

/** What the guided review reads from this site besides the engine. */
const REVIEW_PARTS = new Set(['file', 'context']);

/**
 * A pull request this site's path names, or null. `part` names what the
 * guided review reads (`file` or `context`), only when the path asks for one.
 * @returns {{ owner: string; repo: string; number: number; suffix: string | null; part?: string } | null}
 */
export function matchPrPath(pathname) {
	const m = String(pathname).match(PATH);
	if (!m) return null;
	const [, owner, repo, n, suffix = null, rest] = m;
	const number = Number(n);
	if (!okRepo(repo) || !okNumber(number)) return null;
	if (suffix === 'review' && rest && rest !== '/') {
		const part = rest.slice(1);
		return REVIEW_PARTS.has(part) ? { owner, repo, number, suffix, part } : null;
	}
	return { owner, repo, number, suffix };
}

/**
 * The pull request someone typed or pasted: a github.com URL (with or without
 * the scheme, any PR tab), the same URL on this site, or `owner/repo#123`.
 * @param {string} text @param {string} [ownHost] this site's host, e.g. pr.chrisjowen.net
 */
export function parsePrInput(text, ownHost = '') {
	const s = String(text ?? '').trim();
	const short = s.match(SHORT);
	if (short) {
		const [, owner, repo, n] = short;
		return okRepo(repo) && okNumber(Number(n)) ? { owner, repo, number: Number(n) } : null;
	}
	const m = s.match(INPUT);
	if (!m) return null;
	const [, host, owner, repo, n] = m;
	const h = host.toLowerCase();
	if (h !== 'github.com' && (!ownHost || h !== ownHost.toLowerCase())) return null;
	const number = Number(n);
	return okRepo(repo) && okNumber(number) ? { owner, repo, number } : null;
}

/** This site's path for a pull request. */
export const prPath = ({ owner, repo, number }) => `/${owner}/${repo}/pull/${number}`;

/** The pull request on GitHub. */
export const githubUrl = ({ owner, repo, number }) =>
	`https://github.com/${owner}/${repo}/pull/${number}`;

/** A bookmarklet that opens the GitHub PR you are on here. */
export function bookmarklet(origin) {
	return `javascript:(()=>{const m=location.href.match(/^https:\\/\\/github\\.com\\/([^/]+\\/[^/]+\\/pull\\/\\d+)/);location.href=m?${JSON.stringify(`${origin}/`)}+m[1]:${JSON.stringify(`${origin}/`)}})()`;
}
