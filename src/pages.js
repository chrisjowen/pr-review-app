/**
 * The site's pages, rendered on the server as plain HTML: the marketing page,
 * the public PR page (the rule-based reading plan: no AI, no sign-in), sign-in,
 * the account page and the shell the shared review tab runs in. Everything
 * from GitHub is escaped, except the PR description, which is GitHub's own
 * sanitised `body_html` (and the CSP lets no script run but this site's own).
 */

import { readingPlan } from './plan.js';
import { bookmarklet } from './urls.js';

export const esc = (v) =>
	String(v ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
	);

const money = (n) => `$${Number(n).toFixed(2)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How long ago a moment (ms since the epoch) was, in words, with the moment itself on hover. */
export function ago(at, now = Date.now()) {
	if (!Number.isFinite(at)) return '';
	const s = Math.max(0, Math.round((now - at) / 1000));
	const words =
		s < 60
			? 'just now'
			: s < 3600
				? `${plural(Math.floor(s / 60), 'minute')} ago`
				: s < 86_400
					? `${plural(Math.floor(s / 3600), 'hour')} ago`
					: s < 30 * 86_400
						? `${plural(Math.floor(s / 86_400), 'day')} ago`
						: new Date(at).toISOString().slice(0, 10);
	const when = new Date(at).toISOString().replace('T', ' ').slice(0, 16);
	return `<time datetime="${new Date(at).toISOString()}" title="${when} UTC">${words}</time>`;
}

/** A review as GitHub shows it once posted. */
const POSTED_AS = {
	APPROVE: 'Approved',
	REQUEST_CHANGES: 'Changes requested',
	COMMENT: 'Commented'
};
const shortSha = (sha) => esc(String(sha ?? '').slice(0, 7));
const reviewPath = (s) => `/${esc(s.owner)}/${esc(s.repo)}/pull/${Number(s.number)}/review`;

/** A posted review: its verdict, when, and a link to it on GitHub. */
function postedBadge(p) {
	const label = POSTED_AS[p.event] ?? 'Posted';
	const link = /^https:\/\//.test(p.url ?? '')
		? ` <a href="${esc(p.url)}" rel="noopener">on GitHub ↗</a>`
		: '';
	return `<span class="posted ${esc(p.event)}">${label}</span> ${ago(p.at)}${link}`;
}

/** How a summed-up review's cards are filed, the way the chat files them. */
function verdictChips(parts) {
	const order = [
		['serious', 'serious'],
		['work', 'need work'],
		['like', 'good'],
		['note', 'worth knowing']
	];
	const chips = order
		.filter(([k]) => parts[k])
		.map(([k, words]) => `<span class="vcount ${k}"><b>${parts[k]}</b> ${words}</span>`);
	return chips.length ? `<span class="vcounts">${chips.join('')}</span>` : '';
}

/** Where a review stands: how much is decided, and whether it went up to GitHub. */
function reviewState(s) {
	const progress = s.cards
		? `${s.decided} of ${plural(s.cards, 'change')} decided`
		: 'Not read yet';
	return `${progress} · updated ${ago(s.updatedAt)}${s.posted ? ` · ${postedBadge(s.posted)}` : ''}`;
}

/** A user's reviews, each linking back to it. */
export function reviewList(list) {
	return `<ul class="reviews">${list
		.map(
			(s) => `<li>
  <a class="rv-title" href="${reviewPath(s)}">${esc(s.title || `${s.owner}/${s.repo}#${s.number}`)}</a>
  <span class="rv-ref">${esc(s.owner)}/${esc(s.repo)}#${Number(s.number)}</span>
  <p class="rv-state">${reviewState(s)}</p>
  ${verdictChips(s.parts)}
</li>`
		)
		.join('')}</ul>`;
}

/** Busts browser caches of the stylesheet on each deploy. */
const BOOT = Date.now().toString(36);
const FONTS =
	'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&display=swap';

function layout({ title, body, user, origin, wide = false, bare = false, description = '' }) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="/static/site.css?v=${BOOT}">
</head>
<body class="${bare ? 'bare' : ''}">
<header class="top">
  <a class="brand" href="/"><span class="mark" aria-hidden="true">⌥</span> PR review <em>for humans</em></a>
  <nav>
    ${
			user
				? `<a href="/account">${esc(user.login)}${user.kind === 'demo' ? ' <span class="tag">demo</span>' : ''}</a>
    <form method="post" action="/auth/signout"><button class="linkish">Sign out</button></form>`
				: `<a href="/signin">Sign in</a>`
		}
  </nav>
</header>
<main class="${wide ? 'wide' : ''}">
${body}
</main>
${bare ? '' : `<footer class="foot"><p>PR review for humans reads public pull requests, and posts to GitHub only a review you confirm, as you. It shares its review engine with the <a href="https://github.com/chrisjowen/pr-review-wheelhouse">pr-review-wheelhouse</a> plugin; the site’s own code is <a href="https://github.com/chrisjowen/pr-review-app">open source</a>. ${esc(origin.replace(/^https?:\/\//, ''))}</p></footer>`}
</body>
</html>`;
}

// ---------- marketing ----------

/** The guided review, a step at a time, each with a screenshot of it on the demo PR. */
const FEATURES = [
	{
		img: 'home-overview',
		alt: 'The reviewer’s overview of a pull request: what it does, what needs your attention and what was asked',
		step: 'It reads the whole PR first',
		title: 'An overview before any code',
		text: 'What the PR does, what needs your attention, and what was asked, item by item, with whether it’s met. New to the repo, or a big PR? Ask for the project as a whole, or the story behind the PR.'
	},
	{
		img: 'home-change',
		alt: 'One change in the chat: a Performance risk verdict filed as Serious, with the code it is about',
		step: 'Then one change at a time',
		title: 'A plain verdict on every change',
		text: 'Looks good, Code smell, Possible security issue, Not well tested… filed as What I like, Worth knowing, Needs work or Serious, with a suggestion when there’s a problem. Accept, Disagree or Comment, and the next change comes up. Type to ask about the one in front of you.'
	},
	{
		img: 'home-file',
		alt: 'The whole file open in a drawer beside the chat, at the lines the change is about',
		step: 'The code, in place',
		title: 'The key lines lit, the whole file a click away',
		text: 'Each change shows its code with the lines that matter highlighted. Open the full file at the right line, with its changes a tab away and every card on that file listed.'
	},
	{
		img: 'home-files',
		alt: 'The quick switcher open over the review, filtering the changed files and changes by name',
		step: 'Jump anywhere',
		title: 'The navigator, and ⌘E for any file',
		text: 'Beside the chat, never instead of it, the navigator lists the passage’s groups, stops and every changed file. ⌘E (Ctrl+E) opens a quick switcher; jumping anywhere takes the conversation there.'
	},
	{
		img: 'home-finish',
		alt: 'The finished review: the verdicts, your decisions, a recommended Request changes and the draft to post',
		step: 'Finish, and post it as you',
		title: 'Your verdict, drafted from your decisions',
		text: 'Finish drafts Approve, Request changes or Comment, with the changes you accepted or commented on as inline comments. You see the draft, then post it to the pull request as you, or copy it as Markdown. Your reviews are kept, so you can come back to one.'
	}
];

/** @param {{ user: any; origin: string; demo: string; caps: { userUsd: number }; aiOn: boolean; reviews?: any[] }} o */
export function marketingPage({ user, origin, demo, caps, aiOn, reviews = [] }) {
	const host = origin.replace(/^https?:\/\//, '');
	const example = 'chrisjowen/pr-review-wheelhouse/pull/3';
	const demoPath = new URL(demo).pathname;
	const mine = user
		? `<section class="mine card" aria-labelledby="mine-h">
  <h2 id="mine-h">Your reviews</h2>
  ${reviews.length ? `${reviewList(reviews)}<p class="small"><a href="/account#reviews">All your reviews</a></p>` : '<p class="dim">None yet. Open a pull request here and start the guided review; it’s kept, so you can come back to it.</p>'}
</section>`
		: '';
	const body = `
<section class="hero">
  <p class="eyebrow">Code review, rebalanced</p>
  <h1>PR review for <span class="hl">humans</span>,<br>against <span class="hl2">agent‑generated</span> code.</h1>
  <p class="lede">Agents now open pull requests faster than anyone can read them: a thousand plausible lines, tidy commit messages, green checks. The bottleneck is your attention. This spends it where it counts.</p>

  <div class="swap" aria-label="Change github.com to ${esc(host)} in any pull request URL">
    <p class="swap-label">The whole trick: swap the domain.</p>
    <div class="swap-row">
      <code class="url"><span class="scheme">https://</span><span class="dom gh">github.com</span><span class="path">/${example}</span></code>
      <span class="arrow" aria-hidden="true">↓</span>
      <code class="url"><span class="scheme">https://</span><span class="dom us">${esc(host)}</span><span class="path">/${example}</span></code>
    </div>
  </div>

  <form class="go" action="/go" method="get">
    <label class="sr" for="u">A GitHub pull request URL</label>
    <input id="u" name="url" type="text" required placeholder="https://github.com/owner/repo/pull/123" autocomplete="off" spellcheck="false">
    <button class="btn primary">Read it</button>
  </form>
  <p class="cta-row"><a class="btn ghost" href="${esc(demoPath)}">Open the live demo →</a> <span class="dim">a real 17-file, +1,079 −205 agent PR, with a pre-generated guided review</span></p>
</section>

${mine}

<figure class="reel">
  <video src="/static/home-demo.mp4" poster="/static/home-overview.png" autoplay muted loop playsinline preload="metadata" width="1280" height="800" aria-label="A guided review in progress on the demo pull request"></video>
  <figcaption>A guided review of the demo PR: the overview, a change at a time, the whole file, ⌘E, then finish and post.</figcaption>
</figure>

<section class="band">
  <h2>Free, instant, no AI: a reading plan</h2>
  <p class="sub">Every public PR, no sign-in. Rules about paths and sizes sort the files before you read a line.</p>
  <div class="cards three">
    <article class="card"><span class="pill read">Read first</span><h3>The changes that matter</h3><p>The biggest source changes, grouped with their neighbours, two or three files at a time.</p></article>
    <article class="card"><span class="pill skim">Skim</span><h3>Everything else</h3><p>Tests, docs, config and small edits, grouped by kind, one click from their diff.</p></article>
    <article class="card"><span class="pill gen">Hidden</span><h3>Generated noise</h3><p>Lockfiles, build output, snapshots and minified bundles are counted, then folded away.</p></article>
  </div>
</section>

<section class="band">
  <h2>Then a second pair of eyes: a review you talk through</h2>
  <p class="sub">Sign in with GitHub and press <b>Review it with a second pair of eyes</b> on any PR page. The guided review happens in a chat, on the same engine as the <a href="https://github.com/chrisjowen/pr-review-wheelhouse">pr-review-wheelhouse</a> plugin.</p>
  <div class="features">
    ${FEATURES.map(
			(f) => `<figure class="feature">
      <div><p class="step">${esc(f.step)}</p><h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></div>
      <img src="/static/${f.img}.png" alt="${esc(f.alt)}" width="1920" height="1200" loading="lazy">
    </figure>`
		).join('\n    ')}
  </div>
</section>

<section class="band">
  <h2>What it costs</h2>
  <div class="cards three">
    <article class="card"><span class="pill read">Free</span><h3>The reading plan</h3><p>No AI and no account: free for anyone, on any public pull request.</p></article>
    <article class="card"><span class="pill skim">Free allowance</span><h3>Guided reviews</h3><p>${aiOn ? `Sign in with GitHub for a small daily AI allowance (${money(caps.userUsd)} of model time a day, enough for several reviews), with a hard cap per person and overall, so nobody gets a surprise bill.` : 'Sign in with GitHub for a small daily AI allowance, with a hard cap per person and overall.'}</p></article>
    <article class="card"><span class="pill gen">Your key</span><h3>Unlimited</h3><p>Bring your own OpenRouter or OpenAI key for as many reviews as you like, on the model you pick. It’s encrypted at rest and used only for your reviews.</p></article>
  </div>
  <p class="fine">The engine is model-agnostic; the free allowance runs on a cheap model through OpenRouter. Paid plans come later.</p>
</section>

<section class="band tight">
  <h2>From GitHub in one click</h2>
  <p class="sub">Drag this to your bookmarks bar, then click it on any GitHub pull request: <a class="bookmarklet" href="${esc(bookmarklet(origin))}">Review for humans</a></p>
</section>`;
	return layout({
		title: 'PR review for humans',
		description: `PR review for humans, against agent-generated code. Swap github.com for ${host} in any pull request URL.`,
		body,
		user,
		origin
	});
}

// ---------- the PR page ----------

const STATE_LABEL = { open: 'Open', closed: 'Closed', merged: 'Merged' };
export const MAX_FILE_LINES = 500;
export const MAX_PAGE_LINES = 5000;

function diffTable(f, budget) {
	if (f.binary) return '<p class="dim small">Binary file.</p>';
	const rows = [];
	let used = 0;
	const cap = () => Math.min(MAX_FILE_LINES, budget.left);
	for (const hk of f.hunks) {
		if (used >= cap()) break;
		rows.push(`<tr class="hunk"><td colspan="3">${esc(hk.header)}</td></tr>`);
		for (const l of hk.lines) {
			if (used >= cap()) break;
			const cls = l.t === '+' ? 'a' : l.t === '-' ? 'd' : '';
			rows.push(
				`<tr class="${cls}"><td class="ln">${l.o ?? ''}</td><td class="ln">${l.n ?? ''}</td><td class="code"><span class="sign">${l.t === ' ' ? ' ' : l.t}</span>${esc(l.text)}</td></tr>`
			);
			used++;
		}
	}
	const total = f.hunks.reduce((s, hk) => s + hk.lines.length, 0);
	budget.left -= used;
	const more =
		total > used ? `<p class="dim small more">${total - used} more lines on GitHub.</p>` : '';
	return `<div class="diffwrap"><table class="diff">${rows.join('')}</table></div>${more}`;
}

function fileRow(f, budget, open = false) {
	const status =
		f.status === 'modified' ? '' : `<span class="st ${esc(f.status)}">${esc(f.status)}</span>`;
	return `<details class="file"${open ? ' open' : ''}>
  <summary><span class="path" title="${esc(f.path)}">${esc(f.path)}</span>${status}<span class="churn"><span class="add">+${f.add}</span> <span class="del">−${f.del}</span></span></summary>
  ${diffTable(f, budget)}
</details>`;
}

function checksPanel(pr, checksKnown) {
	if (!checksKnown)
		return '<p class="dim small">Checks couldn’t be read just now (GitHub’s rate limit).</p>';
	if (!pr.checks.length) return '<p class="dim small">No checks reported.</p>';
	const counts = { pass: 0, fail: 0, pending: 0, skipped: 0, neutral: 0 };
	for (const c of pr.checks) counts[c.state]++;
	return `<p class="checksum">${counts.fail ? `<span class="bad">${counts.fail} failing</span> · ` : ''}${counts.pass} passed${counts.pending ? ` · ${counts.pending} pending` : ''}${counts.skipped ? ` · ${counts.skipped} skipped` : ''}</p>
  <ul class="checks">${pr.checks
		.slice(0, 30)
		.map(
			(c) =>
				`<li class="${esc(c.state)}"><span class="dot"></span>${c.url && /^https:\/\//.test(c.url) ? `<a href="${esc(c.url)}" rel="noopener">${esc(c.name)}</a>` : esc(c.name)}</li>`
		)
		.join('')}</ul>`;
}

/**
 * @param {{ user: any; origin: string; pr: any; files: any[]; checksKnown: boolean; demo: boolean; signin: boolean; limit: any; mine?: any; posted?: any[] }} o
 * `mine` is the signed-in user's own review of this PR, summed up; `posted` the reviews of it posted from this site.
 */
export function prPage({
	user,
	origin,
	pr,
	files,
	checksKnown,
	demo,
	signin,
	limit,
	mine = null,
	posted = []
}) {
	const plan = readingPlan(files);
	const budget = { left: MAX_PAGE_LINES };
	const ghUrl = pr.url;
	const reviewHref = `/${pr.owner}/${pr.repo}/pull/${pr.number}/review`;
	const cta = user ? reviewHref : `/signin?next=${encodeURIComponent(reviewHref)}`;

	const read = plan.read
		.map(
			(s, i) => `<div class="stop">
  <h4><span class="num">${i + 1}</span>${esc(s.title)}</h4>
  <p class="why">${esc(s.why)}</p>
  ${s.files.map((f, j) => fileRow(f, budget, i === 0 && j === 0)).join('')}
</div>`
		)
		.join('');
	const skim = plan.skim
		.map(
			(
				g
			) => `<div class="skimgroup"><h4>${esc(g.label)} <span class="count">${g.files.length}</span></h4>
  ${g.files.map((f) => fileRow(f, budget)).join('')}</div>`
		)
		.join('');
	const hidden = plan.hidden.length
		? `<details class="genlist"><summary>${plural(plan.hidden.length, 'generated file')} hidden (+${plan.hidden.reduce((s, f) => s + f.add, 0)} −${plan.hidden.reduce((s, f) => s + f.del, 0)})</summary>
  <ul>${plan.hidden.map((f) => `<li><code>${esc(f.path)}</code> <span class="dim">+${f.add} −${f.del}</span></li>`).join('')}</ul></details>`
		: '<p class="dim small">No generated files.</p>';

	const reviewNote = demo
		? 'A guided review of this PR is pre-generated, so you can try every stage for free.'
		: 'A reviewer reads the whole PR first, then walks you through it a change at a time in a chat: a plain verdict on each, the code with its key lines lit, and every concern in one checklist. You decide each one, then post your review to GitHub as you.';
	const current = mine && mine.headSha === pr.headSha ? mine : null;
	const earlier = mine && !current ? mine : null;
	const ctaLabel = !user
		? 'Sign in to review →'
		: current
			? current.posted
				? 'Open your review →'
				: 'Resume your review →'
			: 'Start the guided review →';
	const ctaButton =
		user || signin
			? `<a class="btn primary big" href="${esc(cta)}">${ctaLabel}</a>`
			: '<p class="dim small">Sign-in isn’t open on this site yet, so the guided review isn’t available. The reading plan below is.</p>';
	const yours = current
		? `<div class="yours"><p class="rv-state"><b>Your review:</b> ${reviewState(current)}</p>${verdictChips(current.parts)}</div>`
		: earlier
			? `<div class="yours"><p class="rv-state"><b>Your review</b> is of an earlier commit (<code>${shortSha(earlier.headSha)}</code>), updated ${ago(earlier.updatedAt)}${earlier.posted ? ` · ${postedBadge(earlier.posted)}` : ''}. Opening it starts afresh at the new head.</p></div>`
			: '';
	const guide = `<section class="guide" aria-labelledby="guide-h">
  <div class="guide-text">
    <p class="eyebrow">Guided review</p>
    <h2 id="guide-h">Review it with a second pair of eyes</h2>
    <p>${reviewNote}</p>
    ${yours}
  </div>
  <div class="guide-go">
    ${ctaButton}
    ${user || !signin ? '' : '<p class="small need">Reviewing needs you to sign in: each person gets a free daily AI allowance, or brings their own key. Reading this page needs no account.</p>'}
  </div>
</section>`;
	const postedList = posted.length
		? `<ul class="postedlist">${posted
				.map(
					(p) =>
						`<li><b>${esc(p.login)}</b> ${postedBadge(p)}${p.headSha && p.headSha !== pr.headSha ? ` <span class="dim">at <code>${shortSha(p.headSha)}</code></span>` : ''}</li>`
				)
				.join('')}</ul>`
		: '<p class="dim small">None yet. A guided review posted to GitHub from this site shows up here.</p>';

	const body = `
<section class="prhead">
  <p class="crumbs"><a href="https://github.com/${esc(pr.owner)}/${esc(pr.repo)}" rel="noopener">${esc(pr.owner)}/${esc(pr.repo)}</a> <a class="num" href="${esc(ghUrl)}" rel="noopener">#${pr.number}</a> <span class="state ${esc(pr.state)}">${pr.isDraft ? 'Draft' : esc(STATE_LABEL[pr.state] ?? pr.state)}</span></p>
  <h1>${esc(pr.title)}</h1>
  <p class="meta"><b>${esc(pr.author)}</b> wants to merge <code>${esc(pr.headRef)}</code> into <code>${esc(pr.baseRef)}</code> · <span class="add">+${pr.additions}</span> <span class="del">−${pr.deletions}</span> · ${plural(pr.changedFiles, 'file')} · <a href="${esc(ghUrl)}" rel="noopener">view on GitHub</a></p>
</section>

${guide}

<div class="prgrid">
  <div class="primary">
    <section class="panel desc">
      <h2>Description</h2>
      <div class="markdown">${pr.bodyHtml || '<p class="dim">No description.</p>'}</div>
    </section>

    <section class="panel plan">
      <div class="planhead">
        <h2>Reading plan</h2>
        <p class="dim small">No AI: sorted by path rules and change size, so it’s free and instant. The guided review refines it.</p>
      </div>
      <h3 class="group"><span class="pill read">Read first</span> ${plural(plan.read.length, 'stop')}, ${plural(plan.counts.read, 'file')}</h3>
      ${read || '<p class="dim">No source changes big enough to read first; everything is in the skim pile.</p>'}
      <h3 class="group"><span class="pill skim">Skim</span> ${plural(plan.counts.skim, 'file')}</h3>
      ${skim || '<p class="dim small">Nothing else.</p>'}
      <h3 class="group"><span class="pill gen">Hidden</span> generated</h3>
      ${hidden}
      ${budget.left <= 0 ? `<p class="dim small">This page shows the first ${MAX_PAGE_LINES.toLocaleString('en')} diff lines; the rest are on GitHub.</p>` : ''}
    </section>
  </div>
  <aside class="side">
    <section class="panel">
      <h2>Reviews posted from here</h2>
      ${postedList}
    </section>
    <section class="panel">
      <h2>Checks</h2>
      ${checksPanel(pr, checksKnown)}
    </section>
    <section class="panel">
      <h2>At a glance</h2>
      <ul class="glance">
        <li><b>${plan.counts.read}</b> to read closely</li>
        <li><b>${plan.counts.skim}</b> to skim</li>
        <li><b>${plan.counts.hidden}</b> generated, hidden</li>
      </ul>
      ${limit?.remaining != null && limit.remaining < 15 ? `<p class="dim small">GitHub API calls left this hour for this site: ${limit.remaining}.</p>` : ''}
    </section>
  </aside>
</div>`;
	return layout({
		title: `${pr.title} · ${pr.owner}/${pr.repo}#${pr.number} · PR review for humans`,
		body,
		user,
		origin,
		wide: true
	});
}

// ---------- sign-in, account, errors ----------

/** @param {{ user: any; origin: string; next: string; github: boolean; demo: boolean; error?: string }} o */
export function signinPage({ user, origin, next, github, demo, error }) {
	const ways = [];
	if (github)
		ways.push(`<a class="btn primary block gh" href="/auth/github?next=${encodeURIComponent(next)}">Sign in with GitHub</a>
  <p class="dim small">Identity only: this site gets your GitHub username and nothing else. No access to your repositories.</p>`);
	if (demo)
		ways.push(`<div class="demo-login">
    <p class="banner"><b>Demo login (local only).</b> This makes you a throwaway reviewer in this browser. No GitHub account is involved.</p>
    <form method="post" action="/auth/demo">
      <input type="hidden" name="next" value="${esc(next)}">
      <button class="btn primary block">Continue as a demo reviewer</button>
    </form>
  </div>`);
	if (!ways.length)
		ways.push(
			'<p class="banner">Sign in with GitHub isn’t open on this site yet. The reading plan on every PR page works without it.</p>'
		);
	const body = `
<section class="narrow card signin">
  <p class="eyebrow">Sign in</p>
  <h1>Sign in to review</h1>
  <p>Reading a PR’s plan is free and needs no account. The guided review uses AI, so it needs to know who you are: each person gets a small daily allowance.</p>
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  ${ways.join('\n')}
</section>`;
	return layout({ title: 'Sign in · PR review for humans', body, user, origin });
}

/**
 * @param {{ user: any; origin: string; status: { reviewer: string; own: any; aiOn: boolean; spent: number; globalSpent: number; caps: { userUsd: number; globalUsd: number } }; providers: any; reviews?: any[]; error?: string; saved?: string | null }} o
 */
export function accountPage({ user, origin, status: s, providers, reviews = [], error, saved }) {
	const pct = Math.min(100, Math.round((s.spent / s.caps.userUsd) * 100));
	const reviewer = s.own
		? `<p><b>${esc(s.reviewer)}</b></p><p>Your own ${esc(s.own.label)} key is in use, so there is no allowance: you pay your provider directly.</p>`
		: s.aiOn
			? `<p><b>${esc(s.reviewer)}</b> on the free allowance.</p><p>Today: <b>${money(s.spent)}</b> of ${money(s.caps.userUsd)} used.</p><div class="meter"><span style="width:${pct}%"></span></div><p class="dim small">Everyone together: ${money(s.globalSpent)} of ${money(s.caps.globalUsd)} today. Both reset at 00:00 UTC.</p>`
			: '<p>Live AI isn’t available on this site right now. Add your own key below to review any PR with it.</p>';
	const options = Object.entries(providers)
		.map(
			([k, p]) =>
				`<option value="${esc(k)}"${s.own?.provider === k ? ' selected' : ''}>${esc(p.label)}</option>`
		)
		.join('');
	const body = `
<section class="narrow">
  <p class="eyebrow">Account</p>
  <h1>${esc(user.name)} <span class="dim">@${esc(user.login)}</span>${user.kind === 'demo' ? ' <span class="tag">demo</span>' : ''}</h1>
  ${error ? `<p class="error">${esc(error)}</p>` : ''}${saved ? `<p class="ok">${esc(saved)}</p>` : ''}
  <div class="card" id="reviews">
    <h2>Your reviews</h2>
    ${reviews.length ? reviewList(reviews) : '<p class="dim">None yet. Swap <code>github.com</code> for this site in a pull request’s URL, then start the guided review; it’s kept here, so you can come back to it.</p>'}
  </div>
  <div class="card">
    <h2>Your reviewer</h2>
    ${reviewer}
  </div>
  <div class="card">
    <h2>Bring your own key</h2>
    <p class="dim">Unlimited reviews on your own provider account. The key is encrypted at rest and only used for your reviews.</p>
    <form method="post" action="/account/key" class="stack">
      <label>Provider <select name="provider">${options}</select></label>
      <label>API key <input name="key" type="password" autocomplete="off" required placeholder="${s.own ? 'saved (enter a new one to replace it)' : 'sk-…'}"></label>
      <label>Model <input name="model" placeholder="${esc(providers.openrouter.model)}" value="${esc(s.own?.model ?? '')}"></label>
      <button class="btn primary">Save key</button>
    </form>
    ${s.own ? '<form method="post" action="/account/key/clear"><button class="btn">Remove my key</button></form>' : ''}
  </div>
  <div class="card">
    <h2>Your data</h2>
    <p class="dim">This site keeps your GitHub username, your reviews, your prompts, your key (sealed) and your GitHub sign-in token (sealed), so a review you confirm can be posted as you. Signing out deletes the token, as does GitHub turning it down; if your session just runs out, the token stays until you sign in again (which replaces it). Forgetting deletes the reviews, prompts, key and token; your username and today’s allowance use stay.</p>
    <form method="post" action="/account/forget"><button class="btn">Forget my reviews and key</button></form>
  </div>
</section>`;
	return layout({ title: 'Account · PR review for humans', body, user, origin });
}

/** @param {{ user: any; origin: string; status: number; message: string; ghUrl?: string }} o */
export function errorPage({ user, origin, status, message, ghUrl }) {
	const eyebrow =
		status === 429 ? 'Rate limited' : status === 404 ? 'Not found' : 'Something went wrong';
	const heading =
		status === 404
			? 'We couldn’t find that'
			: status === 429
				? 'GitHub needs a breather'
				: 'That didn’t work';
	const body = `
<section class="narrow card">
  <p class="eyebrow">${eyebrow}</p>
  <h1>${heading}</h1>
  <p>${esc(message)}</p>
  ${ghUrl ? `<p><a href="${esc(ghUrl)}" rel="noopener">Open it on GitHub instead</a></p>` : ''}
  <p><a class="btn" href="/">Back home</a></p>
</section>`;
	return layout({ title: 'PR review for humans', body, user, origin });
}

/** @param {{ user: any; origin: string; pr: any; settings: any; note: string }} o */
export function reviewShell({ user, origin, pr, settings, note }) {
	const body = `
<div class="shellbar">
  <a href="/${esc(pr.owner)}/${esc(pr.repo)}/pull/${pr.number}">← Reading plan</a>
  <span class="dim small">${esc(note)} · <a href="/${esc(pr.owner)}/${esc(pr.repo)}/pull/${pr.number}/review">Chat review</a> · <a href="/account">Account</a></span>
</div>
<div id="tab" data-pr="${esc(pr.url)}" data-settings="${esc(JSON.stringify(settings))}"></div>
<script type="module" src="/static/review.js"></script>`;
	return layout({
		title: `Review · ${pr.owner}/${pr.repo}#${pr.number}`,
		body,
		user,
		origin,
		bare: true,
		wide: true
	});
}

/**
 * The guided review as a chat (static/chat.js): the conversation in the
 * middle, and beside it, separate from it, the navigator (the passage's groups
 * and stops, and every changed file) and a drawer for a whole file. Everything
 * the chat shows comes from the engine's API and this PR's own files.
 */
export function chatShell({ user, origin, pr, note, live }) {
	const here = `/${esc(pr.owner)}/${esc(pr.repo)}/pull/${pr.number}`;
	const body = `
<div class="chatapp" id="chatapp" data-pr="${esc(pr.url)}" data-path="${here}" data-live="${live ? '1' : '0'}" data-login="${esc(user?.login ?? '')}">
  <div class="cbar">
    <button class="cghost only-narrow" id="navBtn" aria-controls="nav" aria-expanded="false">☰ <span class="hide-phone">Navigator</span></button>
    <a class="cback" href="${here}" title="The reading plan">←</a>
    <div class="ctitle"><a href="${esc(pr.url)}" class="cnum">${esc(pr.owner)}/${esc(pr.repo)}#${pr.number}</a> <span id="prTitle"></span></div>
    <div class="cprogress" title="Changes decided"><span id="progressText" class="hide-phone"></span><span class="ctrack"><span id="progressFill"></span></span></div>
    <button class="cghost" id="filesBtn" title="Go to a changed file">Files <kbd id="swKey" class="hide-phone">Ctrl E</kbd></button>
    <span class="cnote hide-phone">${esc(note)} · <a href="${here}/review?view=cards">Card view</a> · <a href="/account">Account</a></span>
  </div>
  <div class="clayout">
    <nav class="cnav" id="nav" aria-label="Navigator">
      <div class="cnav-head">
        <p class="cnav-label"><span>Navigator</span><button class="linkish only-narrow" id="navClose">Close</button></p>
        <div class="ctabs" role="tablist">
          <button role="tab" id="tabPassage" aria-selected="true" aria-controls="navBody">Passage</button>
          <button role="tab" id="tabFiles" aria-selected="false" aria-controls="navBody">Files <span class="ccount" id="fileCount"></span></button>
        </div>
      </div>
      <div class="cnav-body" id="navBody" role="tabpanel"></div>
      <div class="cnav-foot hide-phone"><span><kbd id="swKey2">Ctrl E</kbd> files</span><span><kbd>/</kbd> type</span><span><kbd>A</kbd> <kbd>D</kbd> <kbd>C</kbd> decide</span><span><kbd>N</kbd> next</span></div>
    </nav>
    <section class="cchat" aria-label="Review conversation">
      <div class="cstream" id="stream"><div class="ccol" id="log" aria-live="polite"><noscript><p>The review needs JavaScript. The <a href="${here}">reading plan</a> works without it.</p></noscript></div></div>
      <div class="ccompose">
        <div class="ccol">
          <div class="cfollow" id="followups" aria-label="Suggested replies"></div>
          <form class="cform" id="composer">
            <label class="sr" for="input">Message the reviewer</label>
            <textarea id="input" rows="1" placeholder="Ask anything about this PR, or say “next”…"></textarea>
            <button class="csend" type="submit" aria-label="Send">→</button>
          </form>
          <div class="cctx"><span id="contextLine"></span></div>
        </div>
      </div>
    </section>
    <aside class="cdrawer" id="drawer" aria-label="File" aria-hidden="true">
      <div class="cdrawer-head">
        <div class="cdrawer-top"><span class="cdrawer-path" id="drawerPath"></span><a class="cicon" id="drawerGh" target="_blank" rel="noopener" title="Open on GitHub" aria-label="Open on GitHub">↗</a><button class="cicon" id="drawerClose" aria-label="Close the file">✕</button></div>
        <div class="cdrawer-sub"><div class="ctabs" role="tablist"><button role="tab" id="dtFull" aria-selected="true">Full file</button><button role="tab" id="dtDiff" aria-selected="false">Changes</button></div><span class="cdrawer-meta" id="drawerMeta"></span></div>
        <div class="cdrawer-cards" id="drawerCards"></div>
      </div>
      <div class="clines" id="drawerLines" tabindex="0"></div>
    </aside>
  </div>
  <div class="cscrim" id="scrim"></div>
  <div class="cswitch" id="switcher" role="dialog" aria-modal="true" aria-label="Go to a changed file">
    <div class="csw">
      <input id="swInput" placeholder="Go to a changed file or card…" autocomplete="off" spellcheck="false" aria-controls="swList">
      <ul id="swList" role="listbox"></ul>
      <div class="csw-foot hide-phone"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> take the chat there</span><span><kbd>Shift</kbd>+<kbd>Enter</kbd> just open the file</span><span><kbd>Esc</kbd> close</span></div>
    </div>
  </div>
</div>
<link rel="stylesheet" href="/static/chat.css?v=${BOOT}">
<script type="module" src="/static/chat.js?v=${BOOT}"></script>`;
	return layout({
		title: `Review · ${pr.owner}/${pr.repo}#${pr.number}`,
		body,
		user,
		origin,
		bare: true,
		wide: true
	});
}
