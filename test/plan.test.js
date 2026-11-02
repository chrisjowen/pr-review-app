import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filesOf, readingPlan } from '../src/plan.js';
import { prPage } from '../src/pages.js';
import { DIFF } from './helpers.js';

describe('the reading plan', () => {
	const files = filesOf(DIFF);
	const plan = readingPlan(files);
	const paths = (list) => list.map((f) => f.path);

	it('puts every changed file in exactly one group', () => {
		const all = [
			...plan.read.flatMap((s) => paths(s.files)),
			...plan.skim.flatMap((g) => paths(g.files)),
			...paths(plan.hidden)
		];
		assert.deepEqual([...all].sort(), paths(files).sort());
		assert.equal(new Set(all).size, all.length);
		assert.equal(plan.counts.read + plan.counts.skim + plan.counts.hidden, files.length);
	});

	it('reads the biggest source changes first, grouped by folder', () => {
		assert.equal(plan.read.length, 1);
		assert.deepEqual(paths(plan.read[0].files), ['src/engine/core.js', 'src/engine/util.js']);
		assert.match(plan.read[0].why, /1 related file from the same folder/);
	});

	it('skims the rest by kind, in a fixed order', () => {
		assert.deepEqual(
			plan.skim.map((g) => [g.kind, paths(g.files)]),
			[
				['source', ['src/tiny.js']],
				['test', ['test/core.test.js']],
				['config', ['package.json']],
				['docs', ['README.md']]
			]
		);
		assert.deepEqual(
			plan.skim.map((g) => g.label),
			['Small source changes', 'Tests', 'Config', 'Docs']
		);
	});

	it('hides generated files', () => {
		assert.deepEqual(paths(plan.hidden), ['package-lock.json']);
	});

	it('copes with a PR with no source changes', () => {
		const docs = readingPlan(files.filter((f) => f.kind === 'docs'));
		assert.equal(docs.read.length, 0);
		assert.equal(docs.counts.skim, 1);
	});

	it('renders the groups on the public page, escaping what GitHub sent', () => {
		const html = prPage({
			user: null,
			origin: 'https://pr.chrisjowen.net',
			pr: {
				owner: 'o',
				repo: 'r',
				number: 7,
				url: 'https://github.com/o/r/pull/7',
				title: '<script>alert(1)</script> tidy',
				author: 'agent',
				state: 'open',
				isDraft: false,
				headRef: 'feat',
				baseRef: 'main',
				additions: 30,
				deletions: 5,
				changedFiles: files.length,
				bodyHtml: '<p>Body</p>',
				checks: [{ name: 'ci', state: 'pass', url: 'javascript:alert(1)' }]
			},
			files,
			checksKnown: true,
			demo: false,
			signin: true,
			limit: { remaining: null }
		});
		assert.ok(!html.includes('<script>alert(1)</script>'));
		assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; tidy'));
		assert.ok(!html.includes('javascript:alert'));
		assert.match(html, /Read first<\/span> 1 stop, 2 files/);
		assert.match(html, /Skim<\/span> 4 files/);
		assert.match(html, /1 generated file hidden/);
		assert.match(html, /href="\/signin\?next=%2Fo%2Fr%2Fpull%2F7%2Freview"/);
	});
});
