/**
 * The chat review's logic, apart from the page: what a card says in the chat
 * (its parts, its code), the order the conversation walks the cards in, when
 * to offer context, what a typed line means, and the small Markdown the
 * reviewer writes in. Pure functions of the engine's review and its deck
 * (`deckOf` in `wheelhouse/ui/cards.js`, which carries the verdict set), so
 * Node's tests read them as the page does. Nothing here imports anything.
 */

/** The deck's verdict set, by id; an unknown verdict reads as an explanation. */
export function verdictTable(verdicts) {
	const m = new Map((verdicts ?? []).map((v) => [v.id, v]));
	const fallback = m.get('explain') ?? {
		id: 'explain',
		label: 'Explanation',
		family: 'neutral',
		blocking: false,
		meaning: ''
	};
	return (id) => m.get(id) ?? fallback;
}

/**
 * How the chat files a verdict: what it likes (praise), what's worth knowing
 * (an explanation), what needs work (a concern that doesn't block) and what's
 * serious (a concern that blocks: security, acceptance criteria, tests,
 * performance).
 */
export const PART_LABEL = {
	like: 'What I like',
	note: 'Worth knowing',
	work: 'Needs work',
	serious: 'Serious'
};

/** @param {string} verdict @param {ReturnType<typeof verdictTable>} vt */
export function partKind(verdict, vt) {
	const v = vt(verdict);
	if (v.family === 'praise') return 'like';
	if (v.family === 'neutral') return 'note';
	return v.blocking ? 'serious' : 'work';
}

/**
 * A card's parts, in the order the chat says them: the main verdict with the
 * card's why, then the secondary verdict with what it means.
 *
 * @param {{ verdict: string; secondary?: string | null; why?: string }} card
 * @param {ReturnType<typeof verdictTable>} vt
 * @returns {{ kind: keyof typeof PART_LABEL; verdict: string; text: string }[]}
 */
export function partsOf(card, vt) {
	const parts = [{ kind: partKind(card.verdict, vt), verdict: card.verdict, text: card.why ?? '' }];
	if (card.secondary && card.secondary !== card.verdict)
		parts.push({
			kind: partKind(card.secondary, vt),
			verdict: card.secondary,
			text: vt(card.secondary).meaning
		});
	return parts;
}

/**
 * The lines of a block the diff holds, from a little before `from` to a
 * little after `to`: new-side lines numbered, removed lines kept in place,
 * and the block's own lines marked to stand out. Empty when the diff doesn't
 * reach those lines (the file drawer then shows them from the whole file).
 *
 * @param {{ hunks?: { lines: { t: string; o?: number; n?: number; text: string }[] }[] } | undefined} file
 * @param {number | null} from @param {number | null} to
 * @returns {{ n: number | null; o: number | null; t: string; text: string; focus: boolean }[]}
 */
export function codeOf(file, from, to, pad = 2) {
	if (!file?.hunks?.length || !from) return [];
	const end = to ?? from;
	const lo = Math.max(1, from - pad);
	const hi = end + pad;
	const out = [];
	for (const h of file.hunks) {
		const lines = h.lines ?? [];
		// From the first new-side line in range to the last, so removed lines between them stay.
		const inRange = (l) => l.t !== '-' && l.n >= lo && l.n <= hi;
		const first = lines.findIndex(inRange);
		if (first < 0) continue;
		const last = lines.findLastIndex(inRange);
		for (const l of lines.slice(first, last + 1))
			out.push({
				n: l.t === '-' ? null : l.n,
				o: l.o ?? null,
				t: l.t,
				text: l.text,
				focus: l.t !== '-' && l.n >= from && l.n <= end
			});
	}
	return out;
}

/**
 * The chat's reading order: every card in the passage's order, with the
 * section it opens (a stop of the key changes, or a group). The generated
 * files close the skim pile, as the approved groups have no group of their own.
 *
 * @param {any} deck
 * @returns {{ id: string; section: string; group: string }[]}
 */
export function readingOrder(deck) {
	const out = [];
	for (const g of deck?.groups ?? []) {
		const group = g.id === 'generated' ? 'skim' : g.id;
		if (g.stops)
			for (const s of g.stops) for (const id of s.cards) out.push({ id, section: s.stage, group });
		else for (const id of g.cards) out.push({ id, section: group, group });
	}
	return out;
}

/** The next card after `from` with no decision yet, wrapping round; null when every card is decided. */
export function nextUndecided(deck, from) {
	const order = readingOrder(deck);
	const decided = new Set((deck?.cards ?? []).filter((c) => c.decision).map((c) => c.id));
	const at = from ? order.findIndex((x) => x.id === from) : -1;
	for (let i = 1; i <= order.length; i++) {
		const x = order[(at + i + order.length) % order.length];
		if (x && !decided.has(x.id)) return x.id;
	}
	return null;
}

/** How big a PR has to be before the chat offers context unasked. */
export const LARGE = { files: 15, lines: 800 };

/**
 * Whether to offer the project or the story before the changes: on a repo
 * the reviewer hasn't reviewed here before, or on a large PR. A context
 * button is there either way. Only a review they did something in (decided
 * a card, or posted it) counts: not one merely opened, nor an untouched demo.
 *
 * @param {any} review the engine's review
 * @param {{ id: string; repo: string; decided?: number; posted?: unknown }[]} others every review kept for this reviewer
 */
export function offerContext(review, others = []) {
	const repo = `${review.pr.owner}/${review.pr.repo}`.toLowerCase();
	const familiar = others.some(
		(r) =>
			String(r.repo).toLowerCase() === repo && r.id !== review.id && (r.decided > 0 || !!r.posted)
	);
	const files = review.files?.length ?? 0;
	const lines = (review.files ?? []).reduce((n, f) => n + (f.add ?? 0) + (f.del ?? 0), 0);
	const large = files >= LARGE.files || lines >= LARGE.lines;
	return { offer: !familiar || large, familiar, large, files, lines };
}

/**
 * What a typed line means: a command the chat carries out itself, or a
 * question for the reviewer. Only “accept” accepts; a casual yes (“ok”,
 * “lgtm”) is `agree`, which the chat confirms before recording anything.
 *
 * @param {string} raw
 * @returns {{ type: 'next' | 'back' | 'accept' | 'agree' | 'disagree' | 'comment' | 'finish' | 'open' | 'goto' | 'context' | 'cancel' | 'ask'; text: string; arg?: string; line?: number }}
 */
export function parseLine(raw) {
	const text = String(raw ?? '').trim();
	const t = text.toLowerCase();
	if (/^(cancel|never ?mind)\b/.test(t)) return { type: 'cancel', text };
	if (/^(next|continue|go on|move on|skip)$/.test(t)) return { type: 'next', text };
	if (/^(back|previous|prev|go back)$/.test(t)) return { type: 'back', text };
	if (/^accept[.!]?$/.test(t)) return { type: 'accept', text };
	if (/^(i )?(agree|lgtm|looks good|ok|okay|fine|sounds (right|good))[.!]?$/.test(t))
		return { type: 'agree', text };
	const dis = text.match(/^(?:i\s+)?disagree\b[,:.!-]*\s*(?:because\s+)?(.*)$/is);
	if (dis) return { type: 'disagree', text, arg: dis[1].trim() };
	const com = text.match(/^comment\b[:\s]*(.*)$/is);
	if (com) return { type: 'comment', text, arg: com[1].trim() };
	if (/^(finish|summary|wrap up|i'?m done|post (it|the review))[.!]?$/.test(t))
		return { type: 'finish', text };
	if (/^(context|the project|the story|project context|story)$/.test(t))
		return { type: 'context', text, arg: /story/.test(t) ? 'story' : 'project' };
	if (/^(open|show)( me)? (the )?(full )?(file|source)$/.test(t)) return { type: 'open', text };
	const go = text.match(/^(?:go to|jump to|take me to|open)\s+(.+)$/i);
	if (go) return { type: 'goto', text, arg: go[1].trim() };
	const line = t.match(/\bline\s+(\d{1,6})\b/);
	return { type: 'ask', text, ...(line ? { line: Number(line[1]) } : {}) };
}

/**
 * A fuzzy match for the quick switcher: a substring anywhere in `s`, or the
 * letters of `q` in order within its last path part. Higher is better; null
 * when it doesn't match.
 *
 * @returns {{ score: number; marks: [number, number][] } | null}
 */
export function fuzzy(q, s) {
	const query = String(q ?? '').toLowerCase();
	const str = String(s ?? '');
	if (!query) return { score: 0, marks: [] };
	const lower = str.toLowerCase();
	const at = lower.indexOf(query);
	const nameAt = lower.lastIndexOf('/') + 1;
	if (at >= 0)
		return {
			score: 100 - at + (at >= nameAt ? 50 : 0) - lower.length * 0.01,
			marks: [[at, at + query.length]]
		};
	const marks = [];
	let i = 0;
	for (let j = nameAt; j < lower.length && i < query.length; j++)
		if (lower[j] === query[i]) {
			marks.push([j, j + 1]);
			i++;
		}
	return i === query.length ? { score: 10 - marks.length * 0.01, marks } : null;
}

const esc = (v) =>
	String(v ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
	);
export { esc };

/** Inline Markdown: `code`, **bold**, *italics* and http(s) links; everything else escaped. */
export function inline(s) {
	return String(s ?? '')
		.split(/(`[^`]+`)/g)
		.map((part, i) =>
			i % 2
				? `<code>${esc(part.slice(1, -1))}</code>`
				: esc(part)
						.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
						.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
						.replace(
							/\bhttps?:\/\/[^\s<>"')]+[^\s<>"').,;:!?]/g,
							(u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`
						)
		)
		.join('');
}

/**
 * The reviewer's Markdown, as HTML: paragraphs, `-`/`1.` lists, `#` headings
 * (shown as bold lines) and fenced code. Nothing in it can run: every piece
 * of text is escaped before it is marked up.
 */
export function markdown(src) {
	const parts = String(src ?? '').split(/```[^\n]*\n([\s\S]*?)(?:```|$)/g);
	let html = '';
	for (let i = 0; i < parts.length; i++) {
		if (i % 2) {
			html += `<pre><code>${esc(parts[i].replace(/\n$/, ''))}</code></pre>`;
			continue;
		}
		const blocks = parts[i].split(/\n{2,}/);
		for (const block of blocks) {
			const lines = block.split('\n').filter((l) => l.trim());
			if (!lines.length) continue;
			if (lines.every((l) => /^\s*[-*]\s+/.test(l)))
				html += `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
			else if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l)))
				html += `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
			else
				html += lines
					.map((l) =>
						/^#{1,6}\s/.test(l)
							? `<p><b>${inline(l.replace(/^#{1,6}\s+/, ''))}</b></p>`
							: `<p>${inline(l)}</p>`
					)
					.join('');
		}
	}
	return html;
}

/** A stage's `take`, which may be one string or a list of paragraphs, as text. */
export const takeText = (take) => (Array.isArray(take) ? take.join('\n\n') : String(take ?? ''));

/** The changed files with the cards that look at each. */
export function filesWithCards(review, deck) {
	const byFile = new Map();
	for (const c of deck?.cards ?? [])
		for (const f of new Set([c.file, ...(c.blocks ?? []).map((b) => b.file)].filter(Boolean)))
			byFile.set(f, [...(byFile.get(f) ?? []), c.id]);
	const generated = new Set(review?.plan?.generated ?? []);
	const gen = (deck?.cards ?? []).find((c) => c.stage === 'generated');
	return (review?.files ?? []).map((f) => ({
		path: f.path,
		add: f.add ?? 0,
		del: f.del ?? 0,
		status: f.status ?? 'modified',
		kind: f.kind ?? 'source',
		generated: generated.has(f.path) || f.kind === 'generated',
		cards:
			byFile.get(f.path) ??
			(gen && (generated.has(f.path) || f.kind === 'generated') ? [gen.id] : [])
	}));
}
