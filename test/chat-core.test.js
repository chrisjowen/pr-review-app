/**
 * The chat review's logic (static/chat-core.js), read the way the page reads
 * it: against the engine's own deck of a real review (the seeded
 * chrisjowen/docket#48) and its verdict set.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CARD_VERDICTS, deckOf } from 'pr-review-wheelhouse/wheelhouse/ui/cards.js';
import {
	codeOf,
	filesWithCards,
	fuzzy,
	markdown,
	nextUndecided,
	offerContext,
	parseLine,
	partKind,
	partsOf,
	readingOrder,
	verdictTable
} from '../static/chat-core.js';

const review = JSON.parse(
	readFileSync(new URL('../seed/chrisjowen__docket__48.json', import.meta.url))
);
const deck = deckOf(review);
const vt = verdictTable(CARD_VERDICTS);
const withDecisions = (ids) =>
	deckOf({
		...review,
		cardDecisions: Object.fromEntries(
			ids.map((id) => [id, { decision: 'accept', text: '', remember: null, at: 1 }])
		)
	});

describe('what a card says in the chat', () => {
	it('files each verdict as liked, worth knowing, needing work or serious (every blocking verdict)', () => {
		const kinds = Object.fromEntries(CARD_VERDICTS.map((v) => [v.id, partKind(v.id, vt)]));
		assert.deepEqual(kinds, {
			exemplary: 'like',
			lgtm: 'like',
			explain: 'note',
			smell: 'work',
			complex: 'work',
			untested: 'serious',
			perf: 'serious',
			ac: 'serious',
			security: 'serious'
		});
		assert.equal(partKind('made-up', vt), 'note', 'an unknown verdict reads as an explanation');
	});

	it('says the main verdict with its why, then the secondary verdict with what it means', () => {
		const card = deck.cards.find((c) => c.verdict === 'security' && c.secondary === 'untested');
		const parts = partsOf(card, vt);
		assert.deepEqual(
			parts.map((p) => [p.kind, p.verdict]),
			[
				['serious', 'security'],
				['serious', 'untested']
			]
		);
		assert.equal(parts[0].text, card.why);
		assert.equal(parts[1].text, 'Behaviour that nothing in the repo checks.');
		assert.equal(partsOf({ verdict: 'lgtm', secondary: null, why: 'x' }, vt).length, 1);
	});

	it('cuts a block’s code from the diff, marking the block’s own lines, removed lines in place', () => {
		const file = review.files.find((f) => f.path.endsWith('src/subgraph-search.ts'));
		const rows = codeOf(file, 54, 56);
		assert.deepEqual(
			rows.map((r) => r.n),
			[52, 53, 54, 55, 56, 57, 58]
		);
		assert.deepEqual(
			rows.filter((r) => r.focus).map((r) => r.n),
			[54, 55, 56]
		);
		const changed = review.files.find((f) => f.path.endsWith('src/neo4j-projection.ts'));
		const mixed = codeOf(changed, 200, 202);
		assert.ok(
			mixed.some((r) => r.t === '-' && r.n === null),
			'removed lines between shown lines stay'
		);
		assert.notEqual(mixed[0].t, '-');
		assert.deepEqual(codeOf(file, 5000, 5001), [], 'lines the diff doesn’t reach');
		assert.deepEqual(codeOf(undefined, 1, 2), []);
	});
});

describe('the order the chat walks the review in', () => {
	it('reads every card once, key changes by stop, then the quality pass, then the skim pile with the generated files last', () => {
		const order = readingOrder(deck);
		assert.equal(order.length, deck.cards.length);
		assert.equal(new Set(order.map((x) => x.id)).size, deck.cards.length);
		assert.deepEqual([...new Set(order.map((x) => x.group))], ['key', 'quality', 'skim']);
		assert.equal(order.at(-1).id, 'generated:c1');
		assert.equal(order.at(-1).group, 'skim');
		assert.deepEqual(
			[...new Set(order.filter((x) => x.group === 'key').map((x) => x.section))],
			['stop-1', 'stop-2']
		);
	});

	it('goes to the next undecided card, wrapping round, and stops when all are decided', () => {
		const order = readingOrder(deck).map((x) => x.id);
		assert.equal(nextUndecided(deck, null), order[0]);
		const some = withDecisions([order[1], order[2]]);
		assert.equal(nextUndecided(some, order[0]), order[3]);
		assert.equal(nextUndecided(withDecisions(order.slice(1)), order[5]), order[0]);
		assert.equal(nextUndecided(withDecisions(order), order[0]), null);
	});
});

describe('when to offer context', () => {
	const small = { ...review, files: review.files.slice(0, 2) };
	it('offers it on a repo the reviewer hasn’t reviewed here before', () => {
		assert.equal(offerContext(small, []).offer, true);
		assert.equal(offerContext(small, [{ id: small.id, repo: 'chrisjowen/docket' }]).offer, true);
	});
	it('goes straight in on a familiar repo, unless the PR is large', () => {
		const others = [{ id: 'chrisjowen__docket__47', repo: 'chrisjowen/docket' }];
		assert.equal(offerContext(small, others).offer, false);
		const big = offerContext(review, others);
		assert.equal(big.large, true, '17 files, over a thousand lines');
		assert.equal(big.offer, true);
	});
});

describe('what a typed line means', () => {
	it('knows the chat’s commands', () => {
		const cases = {
			next: 'next',
			'Go on': 'next',
			back: 'back',
			LGTM: 'accept',
			'accept.': 'accept',
			finish: 'finish',
			'wrap up': 'finish',
			'the story': 'context',
			'open the file': 'open',
			cancel: 'cancel'
		};
		for (const [text, type] of Object.entries(cases))
			assert.equal(parseLine(text).type, type, text);
		assert.deepEqual(parseLine('I disagree because the timeout covers it'), {
			type: 'disagree',
			text: 'I disagree because the timeout covers it',
			arg: 'the timeout covers it'
		});
		assert.equal(parseLine('comment: add a tie-breaker').arg, 'add a tie-breaker');
		assert.equal(parseLine('go to config.ts').arg, 'config.ts');
	});
	it('treats anything else as a question, noting a line number', () => {
		assert.deepEqual(parseLine('Is it exploitable?'), { type: 'ask', text: 'Is it exploitable?' });
		assert.equal(parseLine('what does line 59 do?').line, 59);
		assert.equal(parseLine('ok, but why is this slow?').type, 'ask', 'only a bare “ok” accepts');
	});
});

describe('the quick switcher’s matching', () => {
	it('prefers a match in the file’s name, and matches letters in order within it', () => {
		const a = fuzzy('proj', 'packages/a/src/neo4j-projection.ts');
		const b = fuzzy('proj', 'packages/projects/src/index.ts');
		assert.ok(a.score > b.score);
		assert.ok(fuzzy('ssts', 'src/subgraph-search.ts'));
		assert.equal(fuzzy('pkg', 'packages/a/src/index.ts'), null, 'not across folder names');
	});
});

describe('the reviewer’s Markdown', () => {
	it('marks up paragraphs, lists and code, and escapes everything else', () => {
		const html = markdown(
			'Two **things**:\n\n- `seed.scope`\n- <img src=x onerror=alert(1)>\n\n```ts\nconst a = "<b>";\n```'
		);
		assert.match(html, /<p>Two <b>things<\/b>:<\/p>/);
		assert.match(html, /<li><code>seed\.scope<\/code><\/li>/);
		assert.match(html, /<li>&lt;img src=x onerror=alert\(1\)&gt;<\/li>/);
		assert.match(html, /<pre><code>const a = &quot;&lt;b&gt;&quot;;<\/code><\/pre>/);
		assert.ok(!/<img|<script/.test(markdown('<script>alert(1)</script>')));
	});
	it('links only http(s) addresses', () => {
		assert.match(
			markdown('See https://github.com/o/r/pull/1.'),
			/<a href="https:\/\/github\.com\/o\/r\/pull\/1"/
		);
		assert.ok(!/<a /.test(markdown('javascript:alert(1)')));
	});
});

describe('the changed files beside the chat', () => {
	it('lists every file with the cards that look at it, generated files under their one card', () => {
		const files = filesWithCards(review, deck);
		assert.equal(files.length, review.files.length);
		const search = files.find((f) => f.path.endsWith('src/subgraph-search.ts'));
		assert.ok(search.cards.length >= 5);
		for (const id of search.cards) assert.ok(deck.cards.some((c) => c.id === id));
		const dist = files.filter((f) => f.generated);
		assert.equal(dist.length, 5);
		for (const f of dist) assert.deepEqual(f.cards, ['generated:c1']);
	});
});
