import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bookmarklet, githubUrl, matchPrPath, parsePrInput, prPath } from '../src/urls.js';

describe('the URL swap', () => {
	it('maps a PR path here to the same PR on GitHub and back', () => {
		const at = matchPrPath('/chrisjowen/pr-review-wheelhouse/pull/3');
		assert.deepEqual(at, {
			owner: 'chrisjowen',
			repo: 'pr-review-wheelhouse',
			number: 3,
			suffix: null
		});
		assert.equal(githubUrl(at), 'https://github.com/chrisjowen/pr-review-wheelhouse/pull/3');
		assert.equal(prPath(at), '/chrisjowen/pr-review-wheelhouse/pull/3');
	});

	it('lands GitHub’s own PR tabs on the PR page, and names the guided review', () => {
		for (const [path, suffix] of [
			['/o/r/pull/12/', null],
			['/o/r/pull/12/files', 'files'],
			['/o/r/pull/12/files/abc123..def456', 'files'],
			['/o/r/pull/12/commits/0a1b2c', 'commits'],
			['/o/r/pull/12/checks', 'checks'],
			['/o/r/pull/12/review', 'review']
		])
			assert.equal(matchPrPath(path)?.suffix, suffix, path);
		assert.equal(matchPrPath('/o/r/pull/12/review/more'), null);
		// What the chat review reads besides the engine.
		assert.equal(matchPrPath('/o/r/pull/12/review/file')?.part, 'file');
		assert.equal(matchPrPath('/o/r/pull/12/review/context')?.part, 'context');
		assert.equal(matchPrPath('/o/r/pull/12/review/file/x'), null);
		assert.equal(matchPrPath('/o/r/pull/12/review')?.part, undefined);
	});

	it('keeps owner and repo names GitHub allows, and refuses others', () => {
		assert.ok(matchPrPath('/some-org/repo.js/pull/1'));
		assert.ok(matchPrPath('/a/under_score-and.dots/pull/99'));
		for (const bad of [
			'/o/r/pull/0',
			'/o/r/pull/x',
			'/-o/r/pull/1',
			'/o/../pull/1',
			'/o/./pull/1',
			'/o/r.git/pull/1',
			'/o%2Fx/r/pull/1',
			'/o/r/issues/1',
			'/o/r/pull/1234567890',
			'/o/r/pull/1/blame'
		])
			assert.equal(matchPrPath(bad), null, bad);
	});

	it('reads any way someone pastes a PR', () => {
		const want = { owner: 'chrisjowen', repo: 'docket', number: 48 };
		for (const text of [
			'https://github.com/chrisjowen/docket/pull/48',
			'  https://github.com/chrisjowen/docket/pull/48  ',
			'http://github.com/chrisjowen/docket/pull/48',
			'https://www.github.com/chrisjowen/docket/pull/48',
			'github.com/chrisjowen/docket/pull/48',
			'https://github.com/chrisjowen/docket/pull/48/files',
			'https://github.com/chrisjowen/docket/pull/48#issuecomment-1',
			'https://github.com/chrisjowen/docket/pull/48?w=1',
			'https://GitHub.com/chrisjowen/docket/pull/48',
			'https://pr.chrisjowen.net/chrisjowen/docket/pull/48',
			'chrisjowen/docket#48'
		])
			assert.deepEqual(parsePrInput(text, 'pr.chrisjowen.net'), want, text);
	});

	it('refuses what isn’t a GitHub PR', () => {
		for (const text of [
			'',
			'hello',
			'https://gitlab.com/o/r/pull/1',
			'https://evil.example/o/r/pull/1',
			'https://github.com.evil.example/o/r/pull/1',
			'https://github.com/o/r/issues/1',
			'https://github.com/o/r/pull/',
			'https://github.com/o/r/pull/0',
			'javascript:alert(1)//github.com/o/r/pull/1'
		])
			assert.equal(parsePrInput(text, 'pr.chrisjowen.net'), null, text);
		// This site's own host only counts when it is named.
		assert.equal(parsePrInput('https://pr.chrisjowen.net/o/r/pull/1'), null);
	});

	it('makes a bookmarklet that opens the GitHub PR you are on here', () => {
		const js = bookmarklet('https://pr.chrisjowen.net');
		assert.match(js, /^javascript:/);
		const run = (href) => {
			const location = { href };
			new Function('location', js.slice('javascript:'.length))(location);
			return location.href;
		};
		assert.equal(
			run('https://github.com/chrisjowen/docket/pull/48/files'),
			'https://pr.chrisjowen.net/chrisjowen/docket/pull/48'
		);
		assert.equal(run('https://example.com/'), 'https://pr.chrisjowen.net/');
	});
});
