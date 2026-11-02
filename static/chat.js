/**
 * The guided review as a chat. The conversation is the review: an overview of
 * the PR, context on the project or the story when it helps, then one card
 * per change, each saying what the reviewer likes, what needs work and what is
 * serious, with its code, Accept / Disagree / Comment, and follow-up questions.
 * Anything typed is a question for the reviewer (the engine's chat, in the
 * thread of the card being discussed) or a command ("next", "finish").
 *
 * Beside it, and separate from it, the navigator (the passage's groups and
 * stops, and every changed file, with Ctrl/Cmd+E to switch) only moves the
 * conversation, and a drawer shows a whole file at a line. Finishing drafts
 * the review and posts it to GitHub as the signed-in user, only on a click.
 *
 * Everything comes from the shared engine's API at /engine (the review, its
 * deck of cards, the chat threads, the decisions, posting) and from this
 * site's /review/file and /review/context; nothing is decided here that the
 * engine doesn't keep, so a reload picks up where the review was.
 */

import { draftReview, suggestVerdict, VERDICT_LABEL } from '/ui/draft.js';
import {
	PART_LABEL,
	codeOf,
	esc,
	filesWithCards,
	fuzzy,
	inline,
	markdown,
	nextUndecided,
	offerContext,
	parseLine,
	partKind,
	partsOf,
	readingOrder,
	takeText,
	verdictTable
} from './chat-core.js';

const POLL_MS = 1200;
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#chatapp');
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const PR_URL = app.dataset.pr;
const HERE = app.dataset.path;
const LIVE = app.dataset.live === '1';
const SCOPES = {
	pr: 'Just this pull request',
	me: 'For me, in every repo',
	repo: 'For everyone reviewing this repo'
};

// ---------- the verdict marks ----------
const ICON = {
	exemplary:
		'<path d="M10 2.5l2.3 4.8 5.2.7-3.8 3.6.9 5.2L10 14.3l-4.6 2.5.9-5.2-3.8-3.6 5.2-.7z"/>',
	lgtm: '<circle cx="10" cy="10" r="7.5"/><path d="M6.5 10.2l2.4 2.4 4.6-5"/>',
	explain: '<circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6.2v.1"/>',
	smell: '<circle cx="10" cy="10" r="7.5"/><path d="M6 11c1.3-1.6 2.7-1.6 4 0s2.7 1.6 4 0"/>',
	complex: '<path d="M3 6h9a3 3 0 010 6H8a3 3 0 000 6h9"/>',
	untested:
		'<circle cx="10" cy="10" r="7.5" stroke-dasharray="3 2.4"/><path d="M10 6.5v4M10 13.3v.1"/>',
	perf: '<path d="M3.5 14a6.5 6.5 0 1113 0"/><path d="M10 14l3.5-4.5"/>',
	ac: '<circle cx="10" cy="10" r="7.5"/><circle cx="10" cy="10" r="3.5"/><path d="M15.5 4.5l-3 3"/>',
	security:
		'<path d="M10 2.5l6 2.3v4.6c0 3.9-2.6 6.6-6 8.1-3.4-1.5-6-4.2-6-8.1V4.8z"/><path d="M10 7v4M10 13.4v.1"/>'
};
const mark = (v) =>
	`<svg class="vmark" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[v] ?? ICON.explain}</svg>`;

// ---------- state: the engine's review, and where the conversation is ----------
const S = {
	review: null,
	deck: null,
	vt: verdictTable([]),
	phase: 'loading', // loading → context → review → finish → posted
	current: null, // the card the conversation is about
	shown: new Set(), // cards posted into the chat
	entered: new Set(), // sections already introduced
	pending: null, // { type: 'disagree' | 'comment' | 'remember', card, reason? }
	waiting: null, // a stage the conversation waits on for its cards
	answers: [], // { thread, index, el } replies being written
	others: [],
	files: [],
	viewed: new Set(),
	drawer: null,
	fileText: new Map(),
	started: false,
	edited: false
};
const cardOf = (id) => S.deck?.cards.find((c) => c.id === id) ?? null;
const stageOf = (id) => S.review?.stages.find((s) => s.id === id) ?? null;
const numberOf = (id) => readingOrder(S.deck).findIndex((x) => x.id === id) + 1;
const total = () => readingOrder(S.deck).length;
const base = (p) =>
	String(p ?? '')
		.split('/')
		.pop();
const fileIn = (path) => S.review?.files.find((f) => f.path === path);
const label = (v) => S.vt(v).label;

// ---------- the engine ----------
async function api(method, path, body) {
	const res = await fetch(`/engine${path}`, {
		method,
		headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-pr-review': '1' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const out = await res.json().catch(() => ({}));
	if (!res.ok) {
		const e = new Error(out.error || `The review engine answered ${res.status}.`);
		e.status = res.status;
		throw e;
	}
	return out;
}
const act = (method, path, body) =>
	api(method, `/api/reviews/${S.review.id}${path}`, body).then(take);

function busy(r = S.review) {
	if (!r) return false;
	if (Object.values(r.runs ?? {}).some((x) => x.state === 'running' || x.state === 'queued'))
		return true;
	return Object.values(r.chat ?? {}).some((l) => l.some((m) => m.pending));
}

let pollTimer = null;
function poll() {
	clearTimeout(pollTimer);
	if (!busy()) return;
	pollTimer = setTimeout(async () => {
		try {
			take(await api('GET', `/api/reviews/${S.review.id}`));
		} catch {
			poll();
		}
	}, POLL_MS);
}

/** A fresh copy of the review from the engine: keep it, and move everything waiting on it. */
function take(r) {
	if (!r?.deck) return r;
	S.review = r;
	S.deck = r.deck;
	S.vt = verdictTable(r.deck.verdicts);
	S.files = filesWithCards(r, r.deck);
	for (const a of [...S.answers]) fillAnswer(a);
	drawNav();
	updateProgress();
	if (S.started && S.waiting) void resumeWaiting();
	poll();
	return r;
}

// ---------- the stream ----------
const log = $('#log');
const stream = $('#stream');
const AVATAR = '<div class="cav" aria-hidden="true">⌥</div>';
let queue = Promise.resolve();
const wait = (ms) => new Promise((r) => setTimeout(r, REDUCED ? Math.min(ms, 60) : ms));
const node = (html) => {
	const t = document.createElement('template');
	t.innerHTML = html.trim();
	return t.content.firstElementChild;
};
function scrollTo(el, top = false) {
	const fits = el.offsetHeight < stream.clientHeight * 0.8;
	stream.scrollTo({
		top: top || !fits ? el.offsetTop - 14 : stream.scrollHeight,
		behavior: REDUCED ? 'auto' : 'smooth'
	});
}
const append = (el, top) => {
	log.append(el);
	scrollTo(el, top);
	return el;
};
/** A reviewer message, after a short pause. Resolves to its element. */
function say(html, { about = null, pause = 350, top = false } = {}) {
	const run = async () => {
		const typing = append(
			node(
				`<div class="cmsg">${AVATAR}<div class="cbody"><div class="ctyping" aria-label="The reviewer is writing"><i></i><i></i><i></i></div></div></div>`
			)
		);
		await wait(pause);
		typing.remove();
		const aboutHtml = about ? `<span>about ${ref(about)}</span>` : '';
		return append(
			node(
				`<div class="cmsg">${AVATAR}<div class="cbody"><div class="cwho"><b>Reviewer</b>${aboutHtml}</div>${html}</div></div>`
			),
			top
		);
	};
	const p = queue.then(run);
	queue = p.catch(() => {});
	return p;
}
const sayText = (md, o) => say(`<div class="ctext">${markdown(md)}</div>`, o);
function me(text, tag = '') {
	const el = node(
		`<div class="cmsg me"><div class="cbubble">${tag ? `<span class="ctag">${esc(tag)}</span>` : ''}${inline(text)}</div></div>`
	);
	queue = queue.then(() => void append(el));
	return queue;
}
function divider(html, jump = false) {
	queue = queue.then(
		() => void append(node(`<div class="cdiv${jump ? ' jump' : ''}"><span>${html}</span></div>`))
	);
	return queue;
}

// ---------- smart components ----------
function ref(id) {
	const c = cardOf(id);
	return c
		? `<button class="cref" data-jump="${esc(id)}" style="--v: var(--v-${c.verdict})" title="${esc(label(c.verdict))}">${mark(c.verdict)}${esc(short(c.title))}</button>`
		: '';
}
/** A card's title as a line that takes the chat to it, with an optional note under it. */
function jumpLine(id, note = '') {
	const c = cardOf(id);
	return `<span><button class="clink" data-jump="${esc(id)}">${inline(c?.title ?? id)}</button>${note ? `<span class="cnote">${note}</span>` : ''}</span>`;
}
const short = (t, n = 60) =>
	String(t).length > n
		? `${String(t)
				.slice(0, n - 1)
				.trimEnd()}…`
		: String(t);
function chip(v, cls = '', severity = null) {
	return `<span class="vchip ${cls}" style="--v: var(--v-${v})">${mark(v)}${esc(label(v))}${severity ? ` <span class="sev">· ${esc(severity)}</span>` : ''}</span>`;
}

const KEYWORDS = new Set(
	(
		'const let var function return if else for of in while new throw try catch await async export import from type interface extends ' +
		'typeof as default true false null undefined this class implements readonly void keyof def self None True False elif fn pub use mod impl struct enum match ' +
		'MATCH OPTIONAL WHERE WITH RETURN ORDER BY CALL YIELD AND OR NOT IN AS LIMIT DESC ASC CASE WHEN THEN ELSE END IS NULL COUNT DISTINCT UNWIND MERGE CREATE SET SELECT FROM JOIN GROUP INSERT UPDATE DELETE'
	).split(' ')
);
const TOKEN =
	/(\/\/.*$|\/\*.*?(?:\*\/|$)|^\s*\*(?:\s.*|\/)?$|^\s*#.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`)|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;
/** One line of code, coloured: comments, strings, numbers, keywords and calls. Markdown and text stay plain. */
function hl(line, path) {
	if (/\.(md|txt|rst)$/i.test(path)) return esc(line);
	let out = '';
	let last = 0;
	String(line).replace(TOKEN, (m, com, str, num, fn, _w, at) => {
		out += esc(line.slice(last, at));
		last = at + m.length;
		if (com) out += `<span class="tk-c">${esc(m)}</span>`;
		else if (str) out += `<span class="tk-s">${esc(m)}</span>`;
		else if (num) out += `<span class="tk-n">${esc(m)}</span>`;
		else if (fn) out += `<span class="${KEYWORDS.has(m) ? 'tk-k' : 'tk-f'}">${esc(m)}</span>`;
		else out += KEYWORDS.has(m) ? `<span class="tk-k">${esc(m)}</span>` : esc(m);
		return m;
	});
	return out + esc(line.slice(last));
}

/** A block of a card: the lines the diff holds, or a note to open the file when it doesn't reach them. */
function codeBlock(block, cardId) {
	const f = fileIn(block.file);
	const rows = codeOf(f, block.from, block.to);
	const fresh = f?.status === 'added';
	const range = block.from
		? `${block.from}${block.to && block.to !== block.from ? `–${block.to}` : ''}`
		: '';
	const open = `<button class="cmini" data-open="${esc(block.file)}" data-line="${block.from ?? ''}" data-from="${block.from ?? ''}" data-to="${block.to ?? ''}" data-card="${esc(cardId)}">Open full file</button>`;
	const body = rows.length
		? `<div class="clines"><table>${rows
				.map((l) => {
					const cls = [
						l.t === '+' && !fresh ? 'add' : l.t === '-' ? 'del' : '',
						l.focus ? 'foc' : ''
					]
						.join(' ')
						.trim();
					const n = l.n
						? `<button data-open="${esc(block.file)}" data-line="${l.n}" title="Open the whole file at line ${l.n}">${l.n}</button>`
						: '';
					return `<tr class="${cls}"><td class="n">${n}</td><td class="s">${l.t === ' ' || fresh ? '' : l.t}</td><td>${hl(l.text, block.file)}</td></tr>`;
				})
				.join('')}</table></div>`
		: `<p class="cdim cpad">These lines aren’t in the diff. Open the file to read them in place.</p>`;
	return `<figure class="ccode"><div class="cfile"><span class="cfname"><bdi>${esc(block.file)}</bdi></span><span class="cfrange">${fresh ? 'new file · ' : ''}${esc(range)}</span>${open}</div>${body}</figure>`;
}

function actionsHtml(c) {
	const d = c.decision;
	if (d) {
		const what = { accept: 'Accepted', disagree: 'Disagreed', comment: 'Commented' }[d.decision];
		const detail = [
			d.text ? `“${esc(d.text)}”` : '',
			d.remember ? `remember: ${esc(SCOPES[d.remember])}` : ''
		]
			.filter(Boolean)
			.join(' · ');
		return `<div class="cdecided"><span class="cpill ${d.decision}">${what}</span><span>${detail}</span><button class="linkish" data-undo="${esc(c.id)}">Undo</button></div>`;
	}
	return `<button class="cbtn" data-decide="accept" data-card="${esc(c.id)}">Accept <kbd>A</kbd></button>
		<button class="cbtn" data-decide="disagree" data-card="${esc(c.id)}">Disagree <kbd>D</kbd></button>
		<button class="cbtn" data-decide="comment" data-card="${esc(c.id)}">Comment <kbd>C</kbd></button>`;
}
function asked(c) {
	return new Set((S.review.chat?.[c.id] ?? []).filter((m) => m.role === 'user').map((m) => m.text));
}
function askChips(c) {
	const left = (c.questions ?? []).filter((q) => !asked(c).has(q));
	return left.length
		? `<div class="cqr cask" aria-label="Ask about this change">${left.map((q) => `<button data-ask="${esc(c.id)}" data-q="${esc(q)}">${inline(q)}</button>`).join('')}</div>`
		: '';
}
function sectionTitle(c) {
	if (c.group === 'key') {
		const g = S.deck.groups.find((x) => x.id === 'key');
		const i = g.stops.findIndex((s) => s.stage === c.stage);
		return `Key changes · Stop ${i + 1}: ${g.stops[i]?.title ?? ''}`;
	}
	return { quality: 'Quality pass', skim: 'Skim pile', generated: 'Skim pile' }[c.group] ?? '';
}
const whereOf = (c) =>
	c.file
		? `${base(c.file)}${c.from ? `:${c.from}${c.to && c.to !== c.from ? `–${c.to}` : ''}` : ''}`
		: 'generated files';

function cardHtml(c) {
	const asks = S.deck.groups[0].asks ?? [];
	const askText = c.ask ? asks.find((a) => a.n === c.ask)?.text : null;
	const parts = partsOf(c, S.vt)
		.map(
			(p) =>
				`<div class="cpart ${p.kind}"><div class="cpk">${PART_LABEL[p.kind]}${chip(p.verdict, '', p.verdict === 'security' ? c.severity : null)}</div>${markdown(p.text)}</div>`
		)
		.join('');
	const files =
		c.stage === 'generated'
			? `<ul class="cgen">${(S.review.plan?.generated ?? []).map((p) => `<li><bdi>${esc(p)}</bdi></li>`).join('')}</ul>`
			: '';
	return `<div class="ccard change" data-card="${esc(c.id)}" style="--v: var(--v-${c.verdict})">
		<div class="chead"><span>Change ${numberOf(c.id)} of ${total()} · ${esc(sectionTitle(c))}</span><span class="cwhere">${esc(whereOf(c))}</span></div>
		<div class="chips">${chip(c.verdict, 'main', c.severity)}${c.secondary ? chip(c.secondary, 'second') : ''}</div>
		<h3>${inline(c.title)}</h3>
		${c.take ? `<div class="ctake">${markdown(c.take)}</div>` : ''}
		<div class="cparts">${parts}</div>
		${c.verdict === 'ac' && (c.asked || askText) ? `<div class="casked"><b>What was asked:</b> ${inline(c.asked || askText)}</div>` : askText ? `<p class="cdim small">Checks what was asked: ${inline(askText)}</p>` : ''}
		${(c.blocks ?? []).map((b) => codeBlock(b, c.id)).join('')}${files}
		${c.suggestion ? `<div class="csuggest"><b>Suggestion:</b> ${inline(c.suggestion)}</div>` : ''}
		<div class="cactions" data-actions="${esc(c.id)}">${actionsHtml(c)}</div>
		${askChips(c)}
	</div>`;
}
function refreshCard(id) {
	const c = cardOf(id);
	if (!c) return;
	document
		.querySelectorAll(`[data-actions="${CSS.escape(id)}"]`)
		.forEach((el) => (el.innerHTML = actionsHtml(c)));
	document.querySelectorAll(`[data-card="${CSS.escape(id)}"] .cask`).forEach((el) => el.remove());
	document
		.querySelector(`.ccard[data-card="${CSS.escape(id)}"]`)
		?.insertAdjacentHTML('beforeend', askChips(c));
}

const quick = (opts) =>
	`<div class="cqr">${opts.map(([text, a, solid]) => `<button data-act="${esc(a)}"${solid ? ' class="solid"' : ''}>${esc(text)}</button>`).join('')}</div>`;
const dot = (s) =>
	`<span class="cst ${s}" aria-label="${s}">${s === 'pass' ? '✓' : s === 'fail' ? '✕' : s === 'none' ? '·' : '!'}</span>`;

function countsHtml() {
	return `<div class="ccounts">${S.deck.verdicts
		.filter((v) => S.deck.counts[v.id])
		.map(
			(v) =>
				`<span class="vchip" style="--v: var(--v-${v.id})">${mark(v.id)}${S.deck.counts[v.id]} ${esc(v.label)}</span>`
		)
		.join('')}</div>`;
}
function shapeHtml() {
	return `<div class="cshape" aria-label="Every change, coloured by its verdict">${readingOrder(
		S.deck
	)
		.map(({ id }) => {
			const c = cardOf(id);
			return `<button data-jump="${esc(id)}" style="--v: var(--v-${c.verdict})" title="${esc(`${numberOf(id)}. ${c.title} · ${label(c.verdict)}`)}"></button>`;
		})
		.join('')}</div>`;
}
/** How an acceptance item stands, from the cards that check it. */
function askState(a) {
	const cs = a.cards.map(cardOf).filter(Boolean);
	if (!cs.length) return 'none';
	if (cs.some((c) => c.verdict === 'ac' || c.secondary === 'ac')) return 'fail';
	if (cs.some((c) => S.vt(c.verdict).family === 'concern')) return 'warn';
	return 'pass';
}
function overviewHtml() {
	const r = S.review;
	const w = r.results.walkthrough ?? {};
	const pr = r.pr;
	const add = r.files.reduce((n, f) => n + (f.add ?? 0), 0);
	const del = r.files.reduce((n, f) => n + (f.del ?? 0), 0);
	const serious = S.deck.cards.filter((c) => S.vt(c.verdict).blocking);
	const asks = S.deck.groups[0].asks ?? [];
	const checks = pr.checks ?? [];
	const failing = checks.filter((c) => c.state === 'fail').length;
	return `<div class="ccard cov">
		<h2>${esc(pr.title)}</h2>
		<div class="cmeta"><span>${esc(pr.owner)}/${esc(pr.repo)}#${pr.number}${pr.author ? ` by ${esc(pr.author)}` : ''}</span><span>${r.files.length} files</span><span><span class="a">+${add.toLocaleString()}</span> <span class="d">−${del.toLocaleString()}</span></span>${pr.commits?.length ? `<span>${pr.commits.length} commits</span>` : ''}${checks.length ? `<span>${failing ? `${failing} of ${checks.length} checks failing` : `${checks.length === 1 ? '1 check' : `${checks.length} checks`} passing`}</span>` : ''}</div>
		${w.headline ? `<p class="cgist">${inline(w.headline)}</p>` : ''}
		${w.what ? markdown(w.what) : ''}
		${
			serious.length
				? `<p class="csub">Needs your attention</p><ul class="cchecks">${serious
						.slice(0, 4)
						.map(
							(c) =>
								`<li>${dot('fail')}${jumpLine(c.id)}<span class="crefs">${chip(c.verdict, '', c.severity)}</span></li>`
						)
						.join('')}</ul>`
				: ''
		}
		${asks.length ? `<p class="csub">What was asked</p><ul class="cchecks">${asks.map((a) => `<li>${dot(askState(a))}<span>${inline(a.text)}</span><span class="crefs">${a.cards.map(ref).join('')}</span></li>`).join('')}</ul>` : ''}
		${(w.risks ?? []).length ? `<p class="csub">Risks the description names</p><ul>${w.risks.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>` : ''}
		${S.deck.cards.length ? `<p class="csub">The shape of it: ${total()} changes</p>${shapeHtml()}${countsHtml()}` : ''}
	</div>`;
}
function checklistHtml() {
	const q = S.deck.groups.find((g) => g.id === 'quality');
	const list = q?.checklist ?? [];
	if (!list.length)
		return '<div class="ccard"><p>No concerns anywhere in this PR: nothing to check off.</p></div>';
	return `<div class="ccard"><p class="csub" style="margin-top:0">Quality pass checklist · every concern in the review</p>
		<ul class="cchecks">${list
			.map(
				(x) =>
					`<li>${dot(x.blocking ? 'fail' : 'warn')}${jumpLine(x.card, `${esc(label(x.verdict))}${x.severity ? ` · ${esc(x.severity)}` : ''}${x.blocking ? ' · blocking' : ''}${x.file ? ` · ${esc(base(x.file))}${x.from ? `:${x.from}` : ''}` : ''}${x.decision ? ` · ${{ accept: 'accepted', disagree: 'disagreed', comment: 'commented' }[x.decision]}` : ''}`)}<span class="crefs">${chip(x.verdict)}</span></li>`
			)
			.join('')}</ul></div>`;
}

// ---------- the conversation ----------
async function start() {
	S.started = true;
	const w = S.review.results.walkthrough;
	if (!w) {
		const run = S.review.runs.walkthrough;
		if (run?.state === 'failed') return stageFailed('walkthrough');
		S.waiting = { kind: 'walkthrough' };
		await sayText(
			'I’m reading the pull request now: what it does, why, and how to walk through it. This takes a minute.',
			{ pause: 200 }
		);
		return;
	}
	S.phase = 'context';
	await say(
		`<div class="ctext"><p>I’ve read all ${S.review.files.length} files of this pull request. Here’s the overview; then we’ll go through it one change at a time.</p></div>${overviewHtml()}`,
		{ pause: 250 }
	);
	if (w.take) await sayText(takeText(w.take), { pause: 300 });
	if (S.review.posted) return finish();
	const decided = S.deck.cards.filter((c) => c.decision).length;
	if (decided) {
		await sayText(
			`Welcome back. You’ve decided ${decided} of ${total()} changes, so I’ll pick up at the first one still open. The navigator has the ones you’ve done.`,
			{ pause: 250 }
		);
		return startReview();
	}
	const offer = offerContext(S.review, S.others);
	drawFollowups();
	if (offer.offer) {
		const why = offer.large
			? `It’s a big one (${offer.files} files, ${offer.lines.toLocaleString()} lines)`
			: 'You haven’t reviewed this repo here before';
		await say(
			`<div class="ctext"><p>${why}. Before the changes, do you want some context? I can explain <b>the project as a whole</b>, or <b>the story</b> behind this PR: why it exists and what it was asked to do. Or we can go straight in.</p></div>
			${quick([
				['The project', 'ctx:project'],
				['The story', 'ctx:story'],
				['Both', 'ctx:both'],
				['Start the review', 'start', true]
			])}`,
			{ pause: 300 }
		);
	} else {
		await sayText(
			'You know this repo, so let’s go straight in. Context on the project or the story is a click away below if you want it.',
			{ pause: 250 }
		);
		await startReview();
	}
}

async function showContext(kind) {
	const kinds = kind === 'both' ? ['project', 'story'] : [kind];
	for (const k of kinds) {
		if (k === 'story') await say(storyHtml(), { pause: 400 });
		else {
			try {
				const res = await fetch(`${HERE}/review/context`);
				const p = await res.json();
				if (!res.ok) throw new Error(p.error || 'I couldn’t read the project.');
				await say(projectHtml(p), { pause: 300 });
			} catch (e) {
				await sayText(`I couldn’t read the project from GitHub just now: ${e.message}`, {
					pause: 200
				});
			}
		}
	}
	drawFollowups();
	if (S.phase === 'context')
		await say(
			`<div class="ctext"><p>Ask me anything about it, or let’s start. I’ll go in reading order: the key changes first, then the quality pass, then the skim pile.</p></div>${quick([...(kind === 'project' ? [['The story', 'ctx:story']] : kind === 'story' ? [['The project', 'ctx:project']] : []), ['Start the review', 'start', true]])}`,
			{ pause: 200 }
		);
}
function storyHtml() {
	const w = S.review.results.walkthrough ?? {};
	const pr = S.review.pr;
	const body = String(pr.body ?? '').trim();
	const ev = w.evidence ?? [];
	return `<div class="ctext">
		${w.why ? `<p><b>Why it was made.</b> ${inline(w.why)}</p>` : ''}
		${w.what ? `<p><b>What it does.</b> ${inline(w.what)}</p>` : ''}
		</div>
		${ev.length ? `<div class="ccard"><p class="csub" style="margin-top:0">What the author showed works</p><ul class="cchecks">${ev.map((e) => `<li>${dot(e.status === 'pass' || e.status === 'fixed' ? 'pass' : e.status === 'fail' ? 'fail' : 'warn')}<span>${inline(e.claim)}${e.detail ? `<span class="cnote">${inline(e.detail)}</span>` : ''}</span><span class="cnote">${esc(e.status)}</span></li>`).join('')}</ul></div>` : ''}
		${body ? `<details class="cdetails"><summary>The PR’s description</summary><div class="ctext">${markdown(body.slice(0, 4000))}${body.length > 4000 ? `<p><a href="${esc(pr.url)}" target="_blank" rel="noopener">The rest on GitHub</a></p>` : ''}</div></details>` : ''}`;
}
function projectHtml(p) {
	const readme = String(p.readme ?? '')
		.split('\n')
		.filter((l) => !/^\s*(<|!\[|\[!\[)/.test(l))
		.join('\n')
		.trim();
	const cut = readme.slice(0, 1600);
	return `<div class="ctext">
		<p><b>${esc(p.repo)}</b>${p.description ? `: ${inline(p.description)}` : ''}</p>
		<p class="cdim">${[p.language, p.topics?.length ? p.topics.join(', ') : '', p.stars ? `${p.stars.toLocaleString()} stars` : ''].filter(Boolean).map(esc).join(' · ')}</p>
		</div>
		${cut ? `<div class="ccard creadme"><p class="csub" style="margin-top:0">From its README</p>${markdown(cut)}${readme.length > cut.length ? `<p><a href="${esc(p.url)}#readme" target="_blank" rel="noopener">Read the rest on GitHub</a></p>` : ''}</div>` : ''}`;
}

async function startReview() {
	S.phase = 'review';
	drawFollowups();
	const first = nextUndecided(S.deck, null);
	if (first) return showCard(first);
	return goNext();
}

/** The card-writing stages still to answer, in reading order. */
function unread() {
	return S.review.stages.filter((s) => s.kind !== 'walkthrough' && !S.review.results[s.id]);
}

async function sectionIntro(c) {
	const key = c.group === 'key' ? c.stage : c.group === 'generated' ? 'skim' : c.group;
	if (S.entered.has(key)) return;
	S.entered.add(key);
	if (c.group === 'key') {
		const g = S.deck.groups.find((x) => x.id === 'key');
		const i = g.stops.findIndex((s) => s.stage === c.stage);
		const stop = g.stops[i];
		divider(`<b>Key changes</b> · Stop ${i + 1} of ${g.stops.length}: ${esc(stop.title)}`);
		const take = takeText(S.review.results[c.stage]?.take);
		await sayText(
			`${stop.why ? `**${stop.title}.** ${stop.why}` : `**${stop.title}.**`}${take ? `\n\n${take}` : ''}`,
			{ pause: 300 }
		);
	} else if (c.group === 'quality') {
		divider('<b>Quality pass</b> · structure and naming, then every concern as a checklist');
		const take = takeText(S.review.results[c.stage]?.take);
		await say(
			`<div class="ctext">${take ? markdown(take) : ''}<p>Here’s every concern in this review as one checklist. Each line links the change behind it.</p></div>${checklistHtml()}`,
			{ pause: 350 }
		);
	} else {
		divider('<b>Skim pile</b> · everything else, quickly');
		const skim = S.review.stages.find((s) => s.kind === 'skim');
		const take = skim ? takeText(S.review.results[skim.id]?.take) : '';
		if (take) await sayText(take, { pause: 250 });
	}
}

async function showCard(id, { jumped = false } = {}) {
	const c = cardOf(id);
	if (!c) return;
	S.current = id;
	if (S.phase !== 'finish' && S.phase !== 'posted') S.phase = 'review';
	drawNav();
	updateContext();
	if (stageOf(c.stage))
		void api('POST', `/api/reviews/${S.review.id}/focus`, {
			stage: nextToRead()?.id ?? c.stage
		}).catch(() => {});
	if (S.shown.has(id)) {
		const el = document.querySelector(`.ccard[data-card="${CSS.escape(id)}"]`)?.closest('.cmsg');
		if (el) {
			el.classList.remove('flash');
			void el.offsetWidth;
			el.classList.add('flash');
			stream.scrollTo({ top: el.offsetTop - 14, behavior: REDUCED ? 'auto' : 'smooth' });
		}
		drawFollowups();
		return;
	}
	if (jumped) divider(`Jumped to change ${numberOf(id)}: ${esc(short(c.title, 50))}`, true);
	await sectionIntro(c);
	S.shown.add(id);
	await say(cardHtml(c), { pause: 450, top: true });
	// Earlier questions and answers on this card, from the engine's thread.
	for (const m of S.review.chat?.[id] ?? []) {
		if (m.role === 'user') await me(m.text);
		else if (!m.pending) await sayText(m.text, { pause: 0, about: id });
	}
	drawFollowups();
}

/** The stage to read next: the first unread one after the current card's, else the first unread. */
function nextToRead() {
	const left = unread();
	if (!left.length) return null;
	const at = S.review.stages.findIndex((s) => s.id === cardOf(S.current)?.stage);
	return left.find((s) => S.review.stages.indexOf(s) > at) ?? left[0];
}

async function goNext() {
	const order = readingOrder(S.deck);
	const at = order.findIndex((x) => x.id === S.current);
	const ahead = order.slice(at + 1).find((x) => !cardOf(x.id)?.decision);
	if (ahead) return showCard(ahead.id);
	// Nothing open ahead: wait for a stage still being read, else go back round, else finish.
	const stage = nextToRead();
	if (stage) return waitFor(stage);
	const back = nextUndecided(S.deck, S.current);
	if (back) {
		await sayText(
			`That’s the end of the passage, but ${order.filter((x) => !cardOf(x.id)?.decision).length} changes are still open. Back to the first one.`,
			{ pause: 250 }
		);
		return showCard(back, { jumped: true });
	}
	return finish();
}

async function waitFor(stage) {
	const run = S.review.runs[stage.id];
	if (run?.state === 'failed') return stageFailed(stage.id);
	S.waiting = { kind: 'stage', stage: stage.id };
	void api('POST', `/api/reviews/${S.review.id}/focus`, { stage: stage.id }).catch(() => {});
	if (!run || run.state === 'idle')
		await act('POST', '/run', { stage: stage.id }).catch((e) =>
			sayText(`I can’t read it right now: ${e.message}`)
		);
	await sayText(
		`I’m still reading **${stage.title}**. I’ll carry on as soon as it’s done; ask me anything meanwhile.`,
		{ pause: 200 }
	);
	poll();
}

async function stageFailed(stageId) {
	const s = stageOf(stageId);
	S.waiting = null;
	await say(
		`<div class="ctext"><p>I couldn’t read <b>${esc(s?.title ?? stageId)}</b>: ${esc(String(S.review.runs[stageId]?.reason ?? 'something went wrong').replace(/\.$/, ''))}.</p></div>${quick([['Try again', `run:${stageId}`, true], ...(stageId === 'walkthrough' ? [] : [['Skip it', 'skipstage']])])}`,
		{ pause: 200 }
	);
}

async function resumeWaiting() {
	const w = S.waiting;
	if (!w) return;
	if (w.kind === 'walkthrough') {
		if (S.review.results.walkthrough) {
			S.waiting = null;
			return start();
		}
		if (S.review.runs.walkthrough?.state === 'failed') return stageFailed('walkthrough');
		return;
	}
	if (S.review.results[w.stage]) {
		S.waiting = null;
		return goNext();
	}
	if (S.review.runs[w.stage]?.state === 'failed') return stageFailed(w.stage);
}

// ---------- decisions ----------
function ackText(c, d) {
	const v = S.vt(c.verdict);
	if (d.decision === 'accept') {
		if (v.family === 'concern')
			return v.blocking
				? 'Accepted. I’ll ask for this in the review as a **blocking** change.'
				: 'Accepted. It goes in the review as a **non-blocking** suggestion.';
		if (v.family === 'praise') return 'Noted. I’ll mention it under what works well.';
		return 'Noted. Nothing gets posted for this one.';
	}
	if (d.decision === 'comment') return `Added as a comment on \`${whereOf(c)}\`.`;
	const scope = d.remember
		? ` I’ll remember it **${SCOPES[d.remember].toLowerCase()}** once memory is on; for now it’s kept with this review.`
		: '';
	return `Fair enough, I’ve left it out of the review.${scope}`;
}
async function decide(id, d) {
	S.pending = null;
	try {
		await act('POST', '/card', {
			card: id,
			decision: d.decision,
			text: d.text ?? '',
			remember: d.remember ?? null
		});
	} catch (e) {
		await sayText(`That didn’t save: ${e.message}`, { pause: 150 });
		return drawFollowups();
	}
	refreshCard(id);
	await sayText(ackText(cardOf(id), d), { pause: 250, about: id === S.current ? null : id });
	if (id === S.current) await goNext();
	else drawFollowups();
}
async function startDecision(id, kind, typed = null) {
	const c = cardOf(id);
	if (!c) return;
	if (c.decision)
		return sayText('You’ve already decided this one. Use *Undo* on it to change your mind.', {
			pause: 150
		});
	if (kind === 'accept') {
		await me(typed || 'Accept', `on ${short(c.title, 40)}`);
		return decide(id, { decision: 'accept' });
	}
	if (kind === 'disagree') {
		await me(typed || 'I disagree.', `on ${short(c.title, 40)}`);
		S.pending = { type: 'disagree', card: id };
		drawFollowups();
		return say(
			`<div class="ctext"><p>Fair enough. What’s wrong with it? I’ll leave it out of the review, and I can remember your reason.</p></div>
			<form class="ccard cform2" data-form="disagree" data-card="${esc(id)}">
				<label class="sr" for="dr">Your reason</label><textarea id="dr" placeholder="e.g. This is fine here because…"></textarea>
				<fieldset><legend>Remember this <span>kept with the review; memory comes later</span></legend>
				${Object.entries(SCOPES)
					.map(
						([k, v]) =>
							`<label class="copt"><input type="radio" name="rm" value="${k}"> ${esc(v)}</label>`
					)
					.join('')}
				<label class="copt"><input type="radio" name="rm" value="" checked> Don’t remember</label></fieldset>
				<div class="crow"><button class="cbtn primary" type="submit">Disagree</button><button class="cbtn" type="button" data-cancel>Cancel</button></div>
			</form>`,
			{ pause: 250, about: id }
		);
	}
	await me(typed || 'Comment', `on ${short(c.title, 40)}`);
	S.pending = { type: 'comment', card: id };
	drawFollowups();
	return say(
		`<div class="ctext"><p>What should it say? It goes on <code>${esc(whereOf(c))}</code>.${c.suggestion ? ' I’ve started from my suggestion; edit freely.' : ''}</p></div>
		<form class="ccard cform2" data-form="comment" data-card="${esc(id)}">
			<label class="sr" for="cm">Comment</label><textarea id="cm">${esc(String(c.suggestion ?? '').replace(/`/g, ''))}</textarea>
			<div class="crow"><button class="cbtn primary" type="submit">Add comment</button><button class="cbtn" type="button" data-cancel>Cancel</button></div>
		</form>`,
		{ pause: 250, about: id }
	);
}
function askRemember(id, reason) {
	S.pending = { type: 'remember', card: id, reason };
	drawFollowups();
	return say(
		`<div class="ctext"><p>Got it. Should I remember that beyond this PR?</p></div>${quick([
			[SCOPES.pr, 'rm:pr'],
			[SCOPES.me, 'rm:me'],
			[SCOPES.repo, 'rm:repo'],
			['Don’t remember', 'rm:']
		])}`,
		{ pause: 250, about: id }
	);
}

// ---------- questions: the engine's chat ----------
/** Where a question goes: the card's own thread, or the walkthrough's for the PR as a whole. */
function threadFor(c) {
	if (c && stageOf(c.stage)) return { stage: c.stage, card: c.id, thread: c.id };
	return { stage: 'walkthrough', card: null, thread: 'walkthrough' };
}
async function ask(text, { card = cardOf(S.current), attach = null } = {}) {
	await me(text);
	if (!LIVE) {
		await sayText(
			'Live answers are off on this site right now: the demo reviews are pre-generated. Add your own key on the Account page to ask questions.',
			{ pause: 200 }
		);
		return drawFollowups();
	}
	const t = threadFor(card);
	const el = await say(
		`<div class="ctext canswer"><div class="ctyping"><i></i><i></i><i></i></div></div>`,
		{ pause: 100, about: t.card }
	);
	try {
		await act('POST', '/ask', {
			stage: t.stage,
			text,
			...(t.card ? { card: t.card } : {}),
			...(attach ? { attach } : {})
		});
		const list = S.review.chat?.[t.thread] ?? [];
		const a = { thread: t.thread, index: list.length - 1, el };
		S.answers.push(a);
		fillAnswer(a);
		poll();
	} catch (e) {
		el.querySelector('.canswer').innerHTML =
			`<p>I can’t answer that right now: ${esc(e.message)}</p>`;
	}
	if (card) refreshCard(card.id);
	drawFollowups();
}
function fillAnswer(a) {
	const m = S.review.chat?.[a.thread]?.[a.index];
	const box = a.el.querySelector('.canswer');
	if (!m || !box) return;
	if (m.text) box.innerHTML = markdown(m.text);
	box.classList.toggle('cerror', !!m.error);
	if (!m.pending) {
		S.answers = S.answers.filter((x) => x !== a);
		if (stream.scrollHeight - stream.scrollTop - stream.clientHeight < 200)
			stream.scrollTop = stream.scrollHeight;
	}
}

/** A typed line: a pending form first, then the context question, then commands, then a question. */
async function route(raw) {
	const line = parseLine(raw);
	if (!line.text) return;
	const p = S.pending;
	if (p && line.type === 'cancel') {
		await me(line.text);
		document.querySelector('form.cform2')?.closest('.cmsg')?.remove();
		S.pending = null;
		drawFollowups();
		return sayText('No problem, nothing recorded.', { pause: 150 });
	}
	if (p?.type === 'disagree') {
		document.querySelector('form.cform2')?.closest('.cmsg')?.remove();
		await me(line.text, 'reason');
		return askRemember(p.card, line.text);
	}
	if (p?.type === 'comment') {
		document.querySelector('form.cform2')?.closest('.cmsg')?.remove();
		await me(line.text, 'comment');
		return decide(p.card, { decision: 'comment', text: line.text });
	}
	if (S.phase === 'context') {
		const t = line.text.toLowerCase();
		if (/\bboth\b/.test(t)) return me(line.text).then(() => showContext('both'));
		if (/project|repo|codebase|big picture/.test(t) && t.split(/\s+/).length <= 6)
			return me(line.text).then(() => showContext('project'));
		if (/story|background|why this|history/.test(t) && t.split(/\s+/).length <= 6)
			return me(line.text).then(() => showContext('story'));
		if (/^(no|nope|skip|start|go|let'?s go|begin|ready|straight in)\b/.test(t))
			return me(line.text).then(startReview);
	}
	const cur = S.current;
	switch (line.type) {
		case 'next':
			await me(line.text);
			return S.phase === 'context' ? startReview() : goNext();
		case 'back': {
			await me(line.text);
			const order = readingOrder(S.deck);
			const i = order.findIndex((x) => x.id === cur);
			return i > 0
				? showCard(order[i - 1].id, { jumped: true })
				: sayText('This is the first change.', { pause: 100 });
		}
		case 'accept':
			if (cur) return startDecision(cur, 'accept', line.text);
			break;
		case 'agree': {
			const c = cardOf(cur);
			if (c && !c.decision) {
				await me(line.text);
				return say(
					`<div class="ctext"><p>${partKind(c.verdict, S.vt) === 'serious' ? 'Accept it, so I ask for it in the review as a <b>blocking</b> change?' : 'Accept it?'} Nothing is recorded until you say so.</p></div>${quick(
						[
							['Accept', `accept:${c.id}`, true],
							['Not yet', 'notyet']
						]
					)}`,
					{ pause: 150, about: c.id }
				);
			}
			break;
		}
		case 'disagree':
			if (cur) {
				if (line.arg.length > 3) {
					await me(line.text, 'disagree');
					return askRemember(cur, line.arg);
				}
				return startDecision(cur, 'disagree', line.text);
			}
			break;
		case 'comment':
			if (cur) {
				if (line.arg) {
					await me(line.text);
					return decide(cur, { decision: 'comment', text: line.arg });
				}
				return startDecision(cur, 'comment', line.text);
			}
			break;
		case 'finish':
			await me(line.text);
			return finish();
		case 'context':
			await me(line.text);
			return showContext(line.arg);
		case 'open': {
			const c = cardOf(cur);
			if (c?.file) {
				await me(line.text);
				return openFile(c.file, { line: c.from, from: c.from, to: c.to });
			}
			break;
		}
		case 'goto': {
			const target = findTarget(line.arg);
			if (target?.card) return me(line.text).then(() => showCard(target.card, { jumped: true }));
			if (target?.file) return me(line.text).then(() => jumpToFile(target.file));
			break;
		}
	}
	// A question. A line number on the change being discussed opens the file there too.
	const c = cardOf(cur);
	let attach = null;
	if (line.line && c?.file) {
		const path = S.files.find((f) => line.text.includes(base(f.path)))?.path ?? c.file;
		attach = { file: path, from: line.line, to: line.line };
		openFile(path, { line: line.line, from: line.line, to: line.line });
	}
	return ask(line.text, { card: c, attach });
}
function findTarget(text) {
	const t = text.toLowerCase();
	const file = S.files.find((f) => t.includes(base(f.path).toLowerCase()));
	if (file) return { file: file.path };
	const n = t.match(/(?:change|card|#)\s*(\d{1,3})\b/);
	const order = readingOrder(S.deck);
	if (n && order[Number(n[1]) - 1]) return { card: order[Number(n[1]) - 1].id };
	let best = null;
	for (const c of S.deck.cards) {
		const m = fuzzy(t, c.title);
		if (m && m.score > (best?.score ?? 50)) best = { score: m.score, card: c.id };
	}
	return best;
}

// ---------- finish: the draft, and posting it ----------
async function finish() {
	S.phase = S.review.posted ? 'posted' : 'finish';
	S.current = null;
	S.edited = false;
	drawNav();
	updateContext();
	divider('<b>Finish review</b>');
	if (S.review.posted) {
		await say(
			`<div class="ctext"><p>This review is already posted to GitHub, so there’s nothing more to post.</p></div>${postedHtml()}`,
			{ pause: 200 }
		);
		return drawFollowups();
	}
	const open = readingOrder(S.deck).filter((x) => !cardOf(x.id)?.decision);
	const left = unread();
	if (left.length)
		await sayText(
			`I haven’t finished reading ${left.map((s) => `**${s.title}**`).join(', ')}; its changes aren’t in this draft yet.`,
			{ pause: 200 }
		);
	if (open.length)
		await say(
			`<div class="ctext"><p>${open.length} change${open.length === 1 ? ' is' : 's are'} still undecided, and stay${open.length === 1 ? 's' : ''} out of the review: ${open
				.slice(0, 6)
				.map((x) => ref(x.id))
				.join(
					' '
				)}${open.length > 6 ? ` and ${open.length - 6} more in the navigator.` : ''}</p></div>`,
			{ pause: 200 }
		);
	const rec = suggestVerdict(S.review);
	const draft = draftReview(S.review, { event: rec });
	const decided = S.deck.cards.filter((c) => c.decision);
	const pr = S.review.pr;
	const ownNote =
		pr.author && app.dataset.login && pr.author.toLowerCase() === app.dataset.login.toLowerCase();
	const lead =
		rec === 'REQUEST_CHANGES'
			? 'You accepted at least one blocking concern, so I’d <b>request changes</b>.'
			: rec === 'COMMENT'
				? 'Nothing blocking, but there’s feedback worth posting, so I’d <b>comment</b>.'
				: 'Nothing to ask for, so I’d <b>approve</b>.';
	await say(
		`<div class="ctext"><p>Here’s where we landed. ${lead} Check the draft, pick the verdict and post it.</p></div>
		<div class="ccard" data-finish>
			<p class="csub" style="margin-top:0">This PR</p>${countsHtml()}
			${decided.length ? `<p class="csub">Your decisions</p><table class="cdtable">${decided.map((c) => `<tr><td>${ref(c.id)}</td><td>${{ accept: 'Accepted', disagree: 'Disagreed', comment: 'Comment' }[c.decision.decision]}</td></tr>`).join('')}</table>` : ''}
			${S.deck.remember.length ? `<p class="csub">To remember later</p><ul>${S.deck.remember.map((m) => `<li>${ref(m.card)} · ${esc(SCOPES[m.scope])}: “${esc(m.text)}”</li>`).join('')}</ul>` : ''}
			<p class="csub">Your review</p>
			<div class="cverdicts" role="radiogroup" aria-label="Your verdict">${[
				'APPROVE',
				'REQUEST_CHANGES',
				'COMMENT'
			]
				.map(
					(ev) =>
						`<label><input type="radio" name="ev" value="${ev}"${ev === rec ? ' checked' : ''}><b>${VERDICT_LABEL[ev]}</b><span>${{ APPROVE: 'Nothing blocking', REQUEST_CHANGES: 'Blocks merging', COMMENT: 'Feedback, no verdict' }[ev]}</span>${ev === rec ? '<span class="crec">Recommended</span>' : ''}</label>`
				)
				.join('')}</div>
			<label class="sr" for="reviewBody">The review’s text</label>
			<textarea class="cbodytext" id="reviewBody">${esc(draft.body)}</textarea>
			<p class="cdim small" id="commentCount">${draft.comments.length === 1 ? '1 inline comment goes' : `${draft.comments.length} inline comments go`} with it, on the lines they’re about.${ownNote ? ' GitHub won’t let you approve or request changes on your own PR, so there it goes up as a comment.' : ''}</p>
			<div class="crow"><button class="cbtn primary" data-post>Post to GitHub as you</button><button class="cbtn" data-copy>Copy as Markdown</button></div>
		</div>`,
		{ pause: 350, top: true }
	);
	drawFollowups();
}
async function post(btn) {
	const card = btn.closest('[data-finish]');
	const event = card.querySelector('input[name="ev"]:checked').value;
	const body = card.querySelector('#reviewBody').value;
	const draft = draftReview(S.review, { event });
	card.querySelectorAll('input, textarea, button').forEach((el) => (el.disabled = true));
	await me(`Post: **${VERDICT_LABEL[event]}**`);
	const el = await say('<div class="ctext"><p>Posting to GitHub…</p></div>', { pause: 100 });
	try {
		await act('POST', '/post', { confirm: true, event, body, comments: draft.comments });
	} catch (e) {
		el.remove();
		card.querySelectorAll('input, textarea, button').forEach((x) => (x.disabled = false));
		return say(
			`<div class="ctext cerror"><p>It didn’t post: ${inline(e.message)}</p><p>The draft is still above; you can copy it as Markdown and paste it into the pull request.</p></div>`,
			{ pause: 150 }
		);
	}
	el.remove();
	S.phase = 'posted';
	await say(
		postedHtml(
			draft.comments.length
				? ` with ${draft.comments.length} inline comment${draft.comments.length === 1 ? '' : 's'}`
				: ''
		),
		{ pause: 150 }
	);
	drawFollowups();
}
/** The review as posted: its verdict, a link to it on GitHub, and GitHub's note. */
function postedHtml(extra = '') {
	const done = S.review.posted;
	return `<div class="ccard cposted"><span class="cbadge ${esc(done.event)}">${done.event === 'APPROVE' ? '✓' : done.event === 'REQUEST_CHANGES' ? '!' : '…'}</span>
		<div><b>${VERDICT_LABEL[done.event] ?? 'Review'}</b> posted on <a href="${esc(done.url)}" target="_blank" rel="noopener">${esc(S.review.pr.owner)}/${esc(S.review.pr.repo)}#${S.review.pr.number}</a>${extra}.
		${done.note ? `<p class="cdim">${inline(done.note)}</p>` : ''}</div></div>`;
}

// ---------- jumps from the navigator ----------
async function jumpToFile(path) {
	closeNav();
	const f = S.files.find((x) => x.path === path);
	if (!f) return;
	if (f.cards.length === 1) return showCard(f.cards[0], { jumped: true });
	if (f.cards.length > 1) {
		divider(`Jumped to ${esc(base(path))}`, true);
		const first = f.cards.find((id) => !cardOf(id)?.decision) ?? f.cards[0];
		await say(
			`<div class="ctext"><p><code>${esc(base(path))}</code> has ${f.cards.length} changes in this review: ${f.cards.map(ref).join(' ')}. ${cardOf(first)?.decision ? 'You’ve decided them all; here’s the first.' : 'Here’s the first one you haven’t decided.'}</p></div>`,
			{ pause: 200 }
		);
		return showCard(first);
	}
	divider(`Jumped to ${esc(base(path))}`, true);
	const file = fileIn(path);
	const stillReading = unread().some((s) => s.files?.includes(path));
	const why = f.generated
		? 'It’s generated (build output, a lockfile or a snapshot), so it’s hidden from the review.'
		: stillReading
			? 'I’m still reading the part of the review that covers it.'
			: 'No change in this review looks at it closely; here’s its diff.';
	const rows = (file?.hunks ?? []).flatMap((h) => h.lines).slice(0, 60);
	await say(
		`<div class="ctext"><p>${why}</p></div>${rows.length ? `<figure class="ccode"><div class="cfile"><span class="cfname"><bdi>${esc(path)}</bdi></span><span class="cfrange">+${f.add} −${f.del}</span><button class="cmini" data-open="${esc(path)}">Open full file</button></div><div class="clines"><table>${rows.map((l) => `<tr class="${l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}"><td class="n">${l.n ?? ''}</td><td class="s">${l.t === ' ' ? '' : l.t}</td><td>${hl(l.text, path)}</td></tr>`).join('')}</table></div></figure>` : ''}`,
		{ pause: 250 }
	);
	drawFollowups();
}
async function jumpToSection(section) {
	closeNav();
	if (section === 'walkthrough') {
		const el = log.querySelector('.cov')?.closest('.cmsg');
		if (el) {
			el.classList.remove('flash');
			void el.offsetWidth;
			el.classList.add('flash');
			stream.scrollTo({ top: el.offsetTop - 14, behavior: 'smooth' });
		}
		return;
	}
	if (section === 'finish') return finish();
	const ids = readingOrder(S.deck)
		.filter((x) => x.section === section || x.group === section)
		.map((x) => x.id);
	const first = ids.find((id) => !cardOf(id)?.decision) ?? ids[0];
	if (first) return showCard(first, { jumped: true });
	const stage = stageOf(section) ?? S.review.stages.find((s) => s.kind === section);
	if (stage && !S.review.results[stage.id]) {
		S.current = null;
		return waitFor(stage);
	}
	return sayText('There are no changes in that part of the review.', { pause: 100 });
}

// ---------- the navigator ----------
let navTab = 'passage';
let fileFilter = '';
const navBody = $('#navBody');
function drawNav() {
	if (!S.deck) return;
	$('#tabPassage').setAttribute('aria-selected', String(navTab === 'passage'));
	$('#tabFiles').setAttribute('aria-selected', String(navTab === 'files'));
	$('#fileCount').textContent = S.files.length;
	if (navTab === 'passage') drawPassage();
	else drawFiles();
}
const STATE_NOTE = {
	queued: 'waiting',
	running: 'reading…',
	failed: 'failed',
	idle: 'not read yet'
};
function cardRow(id) {
	const c = cardOf(id);
	if (!c) return '';
	const d = c.decision;
	const note = d
		? { accept: 'Accepted', disagree: 'Disagreed', comment: 'Comment' }[d.decision]
		: S.shown.has(id)
			? 'Open'
			: '';
	return `<li><button class="crowbtn${S.current === id ? ' here' : ''}${d ? ' decided' : ''}" data-jump="${esc(id)}" style="--v: var(--v-${c.verdict})" title="${esc(`${label(c.verdict)}: ${c.title}`)}">${mark(c.verdict)}<span class="ct">${esc(short(c.title, 70))}</span><span class="cd">${note}</span></button></li>`;
}
function drawPassage() {
	const cur = cardOf(S.current);
	const groups = S.deck.groups.filter((g) => g.id !== 'generated');
	const gen = S.deck.groups.find((g) => g.id === 'generated');
	navBody.innerHTML =
		groups
			.map((g, gi) => {
				const ids = g.id === 'skim' ? [...g.cards, ...(gen?.cards ?? [])] : g.cards;
				const here =
					g.id === 'walkthrough'
						? S.phase === 'context'
						: cur && (cur.group === g.id || (g.id === 'skim' && cur.group === 'generated'));
				const done =
					g.id === 'walkthrough'
						? S.phase !== 'loading' && S.phase !== 'context'
						: ids.length > 0 && ids.every((id) => cardOf(id)?.decision);
				const state = g.state && g.state !== 'done' ? ` · ${STATE_NOTE[g.state] ?? g.state}` : '';
				const sub =
					g.id === 'walkthrough'
						? `The overview and context${state}`
						: `${ids.length} change${ids.length === 1 ? '' : 's'} · ${ids.filter((id) => S.vt(cardOf(id)?.verdict).family === 'concern').length} to look at${state}`;
				const dots = ids.length
					? `<span class="cdots">${ids.map((id) => `<i style="--v: var(--v-${cardOf(id)?.verdict})"></i>`).join('')}</span>`
					: '';
				const inner = g.stops
					? g.stops
							.map(
								(s, si) =>
									`<button class="cstoph" data-section="${esc(s.stage)}">Stop ${si + 1} · ${esc(s.title)}${s.state !== 'done' ? ` <span class="cstate">${STATE_NOTE[s.state] ?? s.state}</span>` : ''}</button><ul class="crows">${s.cards.map(cardRow).join('')}</ul>`
							)
							.join('')
					: ids.length
						? `<ul class="crows">${ids.map(cardRow).join('')}</ul>`
						: '';
				return `<div class="cgroup"><button class="cghead${here ? ' here' : ''}${done ? ' done' : ''}" data-section="${g.id}"><span class="num">${done ? '✓' : gi + 1}</span><span><span class="gt">${esc(g.title)}</span><span class="gs">${esc(sub)}</span>${dots}</span></button>${inner}</div>`;
			})
			.join('') + '<button class="cfinish" data-section="finish">Finish review</button>';
}
function drawFiles() {
	const q = fileFilter.toLowerCase();
	const list = S.files.filter((f) => !q || f.path.toLowerCase().includes(q));
	const dirs = new Map();
	for (const f of list) {
		const d = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '(root)';
		dirs.set(d, [...(dirs.get(d) ?? []), f]);
	}
	const viewed = (f) =>
		S.viewed.has(f.path) || (f.cards.length > 0 && f.cards.every((id) => cardOf(id)?.decision));
	navBody.innerHTML =
		`<input class="cfilter" id="ffilter" placeholder="Filter changed files…" value="${esc(fileFilter)}" aria-label="Filter changed files">` +
		[...dirs]
			.map(
				([d, fs]) =>
					`<div class="cdir"><bdi>${esc(d)}</bdi></div>` +
					fs
						.map(
							(f) =>
								`<button class="cfrow${S.drawer?.path === f.path ? ' here' : ''}${viewed(f) ? ' viewed' : ''}" data-file="${esc(f.path)}" title="${esc(f.path)}"><span class="cfi">${viewed(f) ? '✓' : '·'}</span><span class="cfn">${esc(base(f.path))}</span><span class="cfs"><span class="a">+${f.add}</span> <span class="d">−${f.del}</span></span>${f.cards.length ? `<span class="cdots">${f.cards.map((id) => `<i style="--v: var(--v-${cardOf(id)?.verdict})"></i>`).join('')}</span>` : ''}</button>`
						)
						.join('')
			)
			.join('') +
		(list.length ? '' : '<p class="cdim cpad">No changed file matches.</p>');
	const input = $('#ffilter');
	input.addEventListener('input', () => {
		fileFilter = input.value;
		drawFiles();
		const again = $('#ffilter');
		again.focus();
		again.setSelectionRange(again.value.length, again.value.length);
	});
}

// ---------- the file drawer ----------
const drawer = $('#drawer');
function keepBottom() {
	const near = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
	if (near) setTimeout(() => (stream.scrollTop = stream.scrollHeight), 260);
}
async function openFile(path, { line = null, from = null, to = null, mode = null } = {}) {
	const f = fileIn(path);
	if (!f) return;
	const generated = f.kind === 'generated';
	S.drawer = {
		path,
		line: line ? Number(line) : null,
		from: from ? Number(from) : null,
		to: to ? Number(to) : null,
		mode: mode ?? (f.status === 'deleted' || generated ? 'diff' : 'full')
	};
	S.viewed.add(path);
	if (!document.body.classList.contains('drawer-open')) keepBottom();
	document.body.classList.add('drawer-open');
	drawer.setAttribute('aria-hidden', 'false');
	drawDrawer();
	if (navTab === 'files') drawFiles();
	if (S.drawer.mode === 'full' && !S.fileText.has(path)) {
		try {
			const res = await fetch(`${HERE}/review/file?path=${encodeURIComponent(path)}`);
			const out = await res.json();
			S.fileText.set(
				path,
				res.ok ? { text: out.text } : { error: out.error || 'I couldn’t read that file.' }
			);
		} catch {
			S.fileText.set(path, { error: 'I couldn’t read that file.' });
		}
		if (S.drawer?.path === path) drawDrawer();
	}
}
function closeFile() {
	keepBottom();
	document.body.classList.remove('drawer-open');
	drawer.setAttribute('aria-hidden', 'true');
	S.drawer = null;
	if (navTab === 'files') drawFiles();
}
function drawDrawer() {
	const { path, mode, line, from, to } = S.drawer;
	const f = fileIn(path);
	const info = S.files.find((x) => x.path === path);
	$('#drawerPath').innerHTML = `<bdi>${esc(path)}</bdi>`;
	$('#drawerGh').href =
		`https://github.com/${S.review.pr.owner}/${S.review.pr.repo}/blob/${S.review.pr.headSha}/${path.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''}`;
	$('#dtFull').setAttribute('aria-selected', String(mode === 'full'));
	$('#dtDiff').setAttribute('aria-selected', String(mode === 'diff'));
	$('#drawerMeta').innerHTML =
		`<span class="a">+${info?.add ?? 0}</span> <span class="d">−${info?.del ?? 0}</span>`;
	$('#drawerCards').innerHTML = (info?.cards ?? []).map(ref).join('');
	const focus = (n) => from && n >= from && n <= (to ?? from);
	const box = $('#drawerLines');
	if (mode === 'full') {
		const got = S.fileText.get(path);
		if (!got) box.innerHTML = '<p class="cdim cpad">Reading the file…</p>';
		else if (got.error) box.innerHTML = `<p class="cdim cpad">${esc(got.error)}</p>`;
		else {
			const added = new Set(
				f.status === 'added'
					? []
					: (f.hunks ?? [])
							.flatMap((h) => h.lines)
							.filter((l) => l.t === '+')
							.map((l) => l.n)
			);
			box.innerHTML = `<table>${got.text
				.replace(/\n$/, '')
				.split('\n')
				.map((t, i) => {
					const n = i + 1;
					const cls = [added.has(n) ? 'add' : '', focus(n) ? 'foc' : ''].join(' ').trim();
					return `<tr class="${cls}" id="L${n}"><td class="n"><button data-askline="${n}" title="Ask about line ${n}">${n}</button></td><td class="s">${added.has(n) ? '+' : ''}</td><td>${hl(t, path)}</td></tr>`;
				})
				.join('')}</table>`;
		}
	} else {
		const rows = (f.hunks ?? [])
			.map(
				(h) =>
					`<tr class="hunk"><td colspan="3">${esc(h.header ?? '')}</td></tr>${h.lines.map((l) => `<tr class="${l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}${l.n && focus(l.n) ? ' foc' : ''}"${l.n && l.t !== '-' ? ` id="L${l.n}"` : ''}><td class="n">${l.t === '-' ? `<span class="cdim">${l.o ?? ''}</span>` : `<button data-askline="${l.n}">${l.n}</button>`}</td><td class="s">${l.t === ' ' ? '' : l.t}</td><td>${hl(l.text, path)}</td></tr>`).join('')}`
			)
			.join('');
		box.innerHTML = rows
			? `<table>${rows}</table>`
			: `<p class="cdim cpad">${f.kind === 'generated' ? 'A generated file: its changes are hidden from the review.' : 'No changes to show.'}</p>`;
	}
	const place = () => {
		const target = line ? box.querySelector(`#L${line}`) : null;
		box.scrollTop = target
			? Math.max(
					0,
					box.scrollTop +
						target.getBoundingClientRect().top -
						box.getBoundingClientRect().top -
						box.clientHeight / 3
				)
			: 0;
	};
	box.scrollTop = 0;
	requestAnimationFrame(place);
	setTimeout(place, 260);
}

// ---------- the quick switcher (Ctrl+E / Cmd+E) ----------
const switcher = $('#switcher');
const swInput = $('#swInput');
const swList = $('#swList');
let swSel = 0;
let swEntries = [];
let swReturn = null;
function markUp(s, marks) {
	let out = '';
	let last = 0;
	for (const [a, b] of marks) {
		out += esc(s.slice(last, a)) + `<mark>${esc(s.slice(a, b))}</mark>`;
		last = b;
	}
	return out + esc(s.slice(last));
}
function drawSwitcher() {
	const q = swInput.value.trim();
	const files = S.files
		.map((f) => ({ f, m: fuzzy(q, f.path) }))
		.filter((x) => x.m)
		.sort((a, b) => b.m.score - a.m.score);
	const cards = q
		? S.deck.cards.map((c) => ({ c, m: fuzzy(q, c.title) })).filter((x) => x.m && x.m.score >= 50)
		: [];
	swEntries = [
		...files.map((x) => ({ type: 'file', key: x.f.path, x })),
		...cards.map((x) => ({ type: 'card', key: x.c.id, x }))
	];
	swSel = Math.min(swSel, Math.max(0, swEntries.length - 1));
	swList.innerHTML = swEntries.length
		? swEntries
				.map((e, i) => {
					if (e.type === 'file') {
						const f = e.x.f;
						const name = base(f.path);
						const at = f.path.length - name.length;
						const marks = e.x.m.marks.filter(([a]) => a >= at).map(([a, b]) => [a - at, b - at]);
						return `<li><button role="option" data-sw="${i}" aria-selected="${i === swSel}"><span class="swn">${markUp(name, marks)}</span><span class="swd"><bdi>${esc(f.path.slice(0, at) || './')}</bdi> · ${f.cards.length ? `${f.cards.length} change${f.cards.length === 1 ? '' : 's'}` : f.generated ? 'generated' : 'no card'}</span><span class="sws"><span><span class="a">+${f.add}</span> <span class="d">−${f.del}</span></span><span class="cdots">${f.cards.map((id) => `<i style="--v: var(--v-${cardOf(id)?.verdict})"></i>`).join('')}</span></span></button></li>`;
					}
					const c = e.x.c;
					return `<li><button role="option" data-sw="${i}" aria-selected="${i === swSel}"><span class="swn sans">${esc(`${numberOf(c.id)}. ${short(c.title, 70)}`)}</span><span class="swd">change · ${esc(whereOf(c))}</span><span class="sws">${chip(c.verdict)}</span></button></li>`;
				})
				.join('')
		: '<li class="cdim cpad">No changed file or change matches.</li>';
	swList.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}
function openSwitcher() {
	if (!S.deck) return;
	swReturn = document.activeElement;
	switcher.classList.add('open');
	swInput.value = '';
	swSel = 0;
	drawSwitcher();
	swInput.focus();
}
function closeSwitcher() {
	switcher.classList.remove('open');
	swReturn?.focus?.();
}
function pickSwitcher(i, justOpen = false) {
	const e = swEntries[i];
	if (!e) return;
	closeSwitcher();
	if (e.type === 'card') return showCard(e.key, { jumped: true });
	if (justOpen) return openFile(e.key);
	return jumpToFile(e.key);
}
swInput.addEventListener('input', () => {
	swSel = 0;
	drawSwitcher();
});
swInput.addEventListener('keydown', (e) => {
	if (e.key === 'ArrowDown') {
		e.preventDefault();
		swSel = Math.min(swSel + 1, swEntries.length - 1);
		drawSwitcher();
	} else if (e.key === 'ArrowUp') {
		e.preventDefault();
		swSel = Math.max(swSel - 1, 0);
		drawSwitcher();
	} else if (e.key === 'Enter') {
		e.preventDefault();
		pickSwitcher(swSel, e.shiftKey);
	} else if (e.key === 'Escape') {
		e.preventDefault();
		closeSwitcher();
	}
});
switcher.addEventListener('click', (e) => {
	const b = e.target.closest('[data-sw]');
	if (b) pickSwitcher(Number(b.dataset.sw));
	else if (e.target === switcher) closeSwitcher();
});

// ---------- the composer, follow-ups, progress ----------
const input = $('#input');
const followups = $('#followups');
function drawFollowups() {
	let chips = [];
	const c = cardOf(S.current);
	const w = S.review?.results?.walkthrough;
	if (S.pending?.type === 'remember') chips = [];
	else if (S.pending) chips = [['Cancel', 'cancel']];
	else if (S.phase === 'context')
		chips = [
			['The project', 'ctx:project'],
			['The story', 'ctx:story'],
			['Start the review', 'start', true],
			...(LIVE ? (w?.questions ?? []).slice(0, 2).map((q) => [q, `say:${q}`]) : [])
		];
	else if (S.phase === 'review') {
		chips = [['Next change →', 'next', true]];
		if (c?.file) chips.push(['Open the file', 'openfile']);
		chips.push(['Context', 'ctx:menu'], ['Finish review', 'finish']);
	} else if (S.phase === 'finish')
		chips = readingOrder(S.deck).some((x) => !cardOf(x.id)?.decision)
			? [['Go to the first open change', 'firstopen', true]]
			: [];
	followups.innerHTML = chips
		.map(
			([t, a, lead]) =>
				`<button data-act="${esc(a)}"${lead ? ' class="lead"' : ''}>${inline(short(t, 70))}</button>`
		)
		.join('');
}
function updateProgress() {
	const n = S.deck?.cards.filter((c) => c.decision).length ?? 0;
	const all = S.deck ? total() : 0;
	$('#progressText').textContent = all ? `${n} of ${all} decided` : '';
	$('#progressFill').style.width = all ? `${(n / all) * 100}%` : '0';
}
function updateContext() {
	const c = cardOf(S.current);
	$('#contextLine').innerHTML = c
		? `Talking about <b>${numberOf(c.id)}. ${esc(short(c.title, 70))}</b> · ${esc(whereOf(c))}`
		: S.phase === 'finish' || S.phase === 'posted'
			? 'Talking about <b>the whole review</b>'
			: 'Talking about <b>the whole PR</b>';
}
const autosize = () => {
	input.style.height = 'auto';
	input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
};
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
		e.preventDefault();
		$('#composer').requestSubmit();
	}
});
$('#composer').addEventListener('submit', (e) => {
	e.preventDefault();
	const v = input.value;
	input.value = '';
	autosize();
	if (S.started) void route(v);
});

async function onAct(a) {
	if (a === 'start') return me('Start the review').then(startReview);
	if (a === 'ctx:menu')
		return say(
			`<div class="ctext"><p>Which context?</p></div>${quick([
				['The project', 'ctx:project'],
				['The story', 'ctx:story']
			])}`,
			{ pause: 100 }
		);
	if (a.startsWith('ctx:')) {
		const k = a.slice(4);
		await me(
			{
				project: 'Tell me about the project',
				story: 'What’s the story behind this PR?',
				both: 'Both, please'
			}[k]
		);
		return showContext(k);
	}
	if (a === 'next') return me('Next').then(goNext);
	if (a.startsWith('accept:')) return startDecision(a.slice(7), 'accept');
	if (a === 'notyet')
		return me('Not yet').then(() => sayText('Okay, it stays open.', { pause: 100 }));
	if (a === 'finish') return me('Let’s finish').then(finish);
	if (a === 'firstopen') {
		const id = nextUndecided(S.deck, null);
		return id ? showCard(id, { jumped: true }) : null;
	}
	if (a === 'openfile') {
		const c = cardOf(S.current);
		return c?.file ? openFile(c.file, { line: c.from, from: c.from, to: c.to }) : null;
	}
	if (a === 'cancel') return route('cancel');
	if (a === 'skipstage') {
		S.waiting = null;
		return startReview();
	}
	if (a.startsWith('run:')) {
		const stage = a.slice(4);
		try {
			await act('POST', '/run', { stage });
			S.waiting = stage === 'walkthrough' ? { kind: 'walkthrough' } : { kind: 'stage', stage };
			return sayText('Reading it again.', { pause: 100 });
		} catch (e) {
			return sayText(`I can’t read it right now: ${e.message}`, { pause: 100 });
		}
	}
	if (a.startsWith('rm:')) {
		const p = S.pending;
		if (p?.type !== 'remember') return;
		const scope = a.slice(3) || null;
		await me(scope ? SCOPES[scope] : 'Don’t remember');
		return decide(p.card, { decision: 'disagree', text: p.reason, remember: scope });
	}
	if (a.startsWith('say:')) return ask(a.slice(4), { card: cardOf(S.current) });
}

// ---------- one click handler for every smart component ----------
document.addEventListener('click', (e) => {
	const t = e.target.closest('button, a');
	if (!t || !app.contains(t)) return;
	const d = t.dataset;
	if (d.jump) {
		e.preventDefault();
		closeNav();
		void showCard(d.jump, { jumped: true });
	} else if (d.decide) void startDecision(d.card, d.decide);
	else if (d.ask) {
		t.remove();
		void ask(d.q, { card: cardOf(d.ask) });
	} else if (d.act) {
		if (t.closest('.cmsg'))
			t.closest('.cqr')
				?.querySelectorAll('button')
				.forEach((b) => ((b.disabled = true), b === t && b.classList.add('solid')));
		void onAct(d.act);
	} else if (d.open)
		void openFile(d.open, {
			line: d.line || null,
			from: d.from || d.line || null,
			to: d.to || d.line || null
		});
	else if (d.undo) {
		void act('POST', '/card', { card: d.undo, decision: null }).then(() => {
			refreshCard(d.undo);
			return sayText('Undone. That change is open again.', { pause: 100, about: d.undo });
		});
	} else if (d.section) void jumpToSection(d.section);
	else if (d.file) void jumpToFile(d.file);
	else if (d.askline && S.drawer) {
		input.value = `What does ${base(S.drawer.path)} line ${d.askline} do?`;
		autosize();
		input.focus();
	} else if (t.matches('[data-post]')) void post(t);
	else if (t.matches('[data-copy]')) {
		const text = t.closest('[data-finish]').querySelector('#reviewBody').value;
		void navigator.clipboard?.writeText(text).then(() => (t.textContent = 'Copied'));
	} else if (t.matches('[data-cancel]')) {
		t.closest('.cmsg')?.remove();
		S.pending = null;
		drawFollowups();
		void sayText('No problem, nothing recorded.', { pause: 100 });
	}
});
document.addEventListener('change', (e) => {
	const card = e.target.closest?.('[data-finish]');
	if (!card || e.target.name !== 'ev' || S.edited) return;
	const draft = draftReview(S.review, { event: e.target.value });
	card.querySelector('#reviewBody').value = draft.body;
});
document.addEventListener('input', (e) => {
	if (e.target.id === 'reviewBody') S.edited = true;
});
document.addEventListener('submit', (e) => {
	const form = e.target.closest('form[data-form]');
	if (!form) return;
	e.preventDefault();
	const id = form.dataset.card;
	const value = form.querySelector('textarea').value.trim();
	form.closest('.cmsg')?.remove();
	if (form.dataset.form === 'disagree') {
		const remember = form.querySelector('input[name="rm"]:checked')?.value || null;
		void me(value || 'No reason given.', 'reason').then(() =>
			decide(id, { decision: 'disagree', text: value, remember })
		);
	} else if (value)
		void me(value, 'comment').then(() => decide(id, { decision: 'comment', text: value }));
	else {
		S.pending = null;
		drawFollowups();
	}
});

// ---------- chrome: tabs, drawers, keys ----------
$('#tabPassage').addEventListener('click', () => ((navTab = 'passage'), drawNav()));
$('#tabFiles').addEventListener('click', () => ((navTab = 'files'), drawNav()));
$('#dtFull').addEventListener(
	'click',
	() => S.drawer && openFile(S.drawer.path, { ...S.drawer, mode: 'full' })
);
$('#dtDiff').addEventListener(
	'click',
	() => S.drawer && openFile(S.drawer.path, { ...S.drawer, mode: 'diff' })
);
$('#drawerClose').addEventListener('click', closeFile);
function closeNav() {
	document.body.classList.remove('nav-open');
	$('#navBtn').setAttribute('aria-expanded', 'false');
}
$('#navBtn').addEventListener('click', () => {
	const open = document.body.classList.toggle('nav-open');
	$('#navBtn').setAttribute('aria-expanded', String(open));
});
$('#navClose').addEventListener('click', closeNav);
$('#scrim').addEventListener('click', () => (closeNav(), closeFile()));
$('#filesBtn').addEventListener('click', openSwitcher);
$('#swKey').textContent = MAC ? '⌘E' : 'Ctrl E';
$('#swKey2').textContent = MAC ? '⌘E' : 'Ctrl E';
if (matchMedia('(max-width: 640px)').matches) input.placeholder = 'Ask, or say “next”…';
document.addEventListener('keydown', (e) => {
	if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'e') {
		e.preventDefault();
		if (switcher.classList.contains('open')) closeSwitcher();
		else openSwitcher();
		return;
	}
	if (e.key === 'Escape') {
		if (switcher.classList.contains('open')) closeSwitcher();
		else if (document.body.classList.contains('drawer-open')) closeFile();
		else closeNav();
		return;
	}
	const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
	if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
	if (e.key === '/') {
		e.preventDefault();
		input.focus();
		return;
	}
	const cur = S.current;
	if (!cur || S.pending || S.phase !== 'review') return;
	const k = e.key.toLowerCase();
	if (k === 'a') void startDecision(cur, 'accept');
	else if (k === 'd') void startDecision(cur, 'disagree');
	else if (k === 'c') void startDecision(cur, 'comment');
	else if (k === 'n') void me('Next').then(goNext);
});

// ---------- go ----------
async function boot() {
	updateContext();
	try {
		const r = await api('POST', '/api/reviews', { url: PR_URL });
		$('#prTitle').textContent = r.pr?.title ?? '';
		S.others = (await api('GET', '/api/reviews').catch(() => ({ reviews: [] }))).reviews ?? [];
		take(r);
		await start();
	} catch (e) {
		S.phase = 'error';
		await say(
			`<div class="ctext cerror"><p>I couldn’t open this review: ${inline(e.message)}</p><p><a href="${esc(HERE)}">The reading plan</a> works without the reviewer.</p></div>`,
			{ pause: 100 }
		);
	}
}
void boot();
