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
${bare ? '' : `<footer class="foot"><p>PR review for humans reads public pull requests and never posts to GitHub. It shares its review engine with the <a href="https://github.com/chrisjowen/pr-review-wheelhouse">pr-review-wheelhouse</a> plugin; the site’s own code is <a href="https://github.com/chrisjowen/pr-review-app">open source</a>. ${esc(origin.replace(/^https?:\/\//, ''))}</p></footer>`}
</body>
</html>`;
}

// ---------- marketing ----------

/** @param {{ user: any; origin: string; demo: string; caps: { userUsd: number }; aiOn: boolean }} o */
export function marketingPage({ user, origin, demo, caps, aiOn }) {
	const host = origin.replace(/^https?:\/\//, '');
	const example = 'chrisjowen/pr-review-wheelhouse/pull/3';
	const demoPath = new URL(demo).pathname;
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

<section class="band">
  <h2>Free, instant, no AI: a reading plan</h2>
  <p class="sub">Every public PR, no sign-in. Rules about paths and sizes sort the files before you read a line.</p>
  <div class="cards three">
    <article class="card"><span class="pill read">Read first</span><h3>The changes that matter</h3><p>The biggest source changes, grouped with their neighbours, two or three files at a time.</p></article>
    <article class="card"><span class="pill skim">Skim</span><h3>Everything else</h3><p>Tests, docs, config and small edits, grouped by kind, one click from their diff.</p></article>
    <article class="card"><span class="pill gen">Hidden</span><h3>Generated noise</h3><p>Lockfiles, build output, snapshots and minified bundles are counted, then folded away.</p></article>
  </div>
</section>

<section class="band split">
  <div>
    <h2>Then a second pair of eyes, if you want one</h2>
    <p class="sub">Sign in with GitHub to start a guided review. It walks you through the PR in stages, and a reviewer sits beside the code to talk each one through.</p>
    <ol class="stages">
      <li><b>Walkthrough.</b> What the PR does and why, the evidence it claims, where the files went.</li>
      <li><b>Quality pass.</b> Readability only: nesting, long functions, duplication, names. Keep or dismiss each note.</li>
      <li><b>Stops.</b> The important changes, with notes pinned above the lines, alternatives, and the reviewer’s pick.</li>
      <li><b>Skim pile.</b> One line and a risk level for everything else.</li>
    </ol>
    <p class="fine">You decide. Questions and change requests pin to lines; <b>Finish review</b> drafts your verdict, and you copy it as Markdown. Nothing is posted anywhere.</p>
  </div>
  <figure class="shot"><img src="/static/stop-web.png" alt="A stop in the guided review: a reviewer note pinned above the lines it discusses" loading="lazy"><figcaption>A stop: notes pinned above the lines they discuss.</figcaption></figure>
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

/** @param {{ user: any; origin: string; pr: any; files: any[]; checksKnown: boolean; demo: boolean; signin: boolean; limit: any }} o */
export function prPage({ user, origin, pr, files, checksKnown, demo, signin, limit }) {
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
		? 'A guided review of this PR is pre-generated, so you can try every stage.'
		: 'A walkthrough, a quality pass, the key changes a few files at a time, a skim pile, and a reviewer to talk it through.';
	const ctaButton =
		user || signin
			? `<a class="btn primary block" href="${esc(cta)}">${user ? 'Start the guided review →' : 'Sign in to review →'}</a>`
			: '<p class="dim small">Sign-in isn’t open on this site yet, so the guided review isn’t available. The reading plan is.</p>';

	const body = `
<section class="prhead">
  <p class="crumbs"><a href="https://github.com/${esc(pr.owner)}/${esc(pr.repo)}" rel="noopener">${esc(pr.owner)}/${esc(pr.repo)}</a> <a class="num" href="${esc(ghUrl)}" rel="noopener">#${pr.number}</a> <span class="state ${esc(pr.state)}">${pr.isDraft ? 'Draft' : esc(STATE_LABEL[pr.state] ?? pr.state)}</span></p>
  <h1>${esc(pr.title)}</h1>
  <p class="meta"><b>${esc(pr.author)}</b> wants to merge <code>${esc(pr.headRef)}</code> into <code>${esc(pr.baseRef)}</code> · <span class="add">+${pr.additions}</span> <span class="del">−${pr.deletions}</span> · ${plural(pr.changedFiles, 'file')} · <a href="${esc(ghUrl)}" rel="noopener">view on GitHub</a></p>
</section>

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
    <section class="panel review-cta">
      <p class="eyebrow">Guided review</p>
      <h2>Review it with a second pair of eyes</h2>
      <p>${reviewNote}</p>
      ${ctaButton}
      ${user || !signin ? '' : '<p class="dim small">Reading this page needs no account. Reviewing does, so the free AI allowance is per person.</p>'}
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
 * @param {{ user: any; origin: string; status: { reviewer: string; own: any; aiOn: boolean; spent: number; globalSpent: number; caps: { userUsd: number; globalUsd: number } }; providers: any; error?: string; saved?: string | null }} o
 */
export function accountPage({ user, origin, status: s, providers, error, saved }) {
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
    <p class="dim">This site keeps your GitHub username, your reviews, your prompts and your key (sealed). Forgetting deletes the reviews, prompts and key; your username and today’s allowance use stay.</p>
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
  <span class="dim small">${esc(note)} · <a href="/account">Account</a></span>
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
