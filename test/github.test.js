/**
 * What the GitHub reader adds for the chat review: one changed file whole at
 * a commit (for the file drawer) and the project as a whole (for context),
 * against a fake GitHub.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHubReader } from '../src/github.js';

const SHA = 'abc1234def';

function fakeGitHub(routes) {
	const calls = [];
	const fetch = async (url) => {
		calls.push(String(url));
		const hit = routes[String(url)];
		if (hit === undefined) return new Response('', { status: 404 });
		return typeof hit === 'string'
			? new Response(hit, { status: 200 })
			: Response.json(hit, { status: 200 });
	};
	return { fetch, calls };
}

describe('the GitHub reader, for the chat review', () => {
	it('reads a file at a commit from the raw host, once, and says when it isn’t there', async () => {
		const gh = fakeGitHub({
			[`https://raw.example/o/r/${SHA}/src/a%20b.js`]: 'export const a = 1;\n'
		});
		const reader = createGitHubReader({ fetch: gh.fetch, raw: 'https://raw.example' });
		assert.equal(await reader.file('o', 'r', SHA, 'src/a b.js'), 'export const a = 1;\n');
		assert.equal(await reader.file('o', 'r', SHA, 'src/a b.js'), 'export const a = 1;\n');
		assert.equal(gh.calls.length, 1, 'a file at a commit never changes, so it is kept');
		assert.equal(await reader.file('o', 'r', SHA, 'src/gone.js'), null);
		// Paths are case-sensitive: a file isn't mistaken for one that differs only in case.
		assert.equal(await reader.file('o', 'r', SHA, 'src/Gone.js'), null);
		assert.equal(gh.calls.length, 3);
	});

	it('refuses paths and commits that aren’t a file in a pull request', async () => {
		const gh = fakeGitHub({});
		const reader = createGitHubReader({ fetch: gh.fetch, raw: 'https://raw.example' });
		for (const [sha, path] of [
			[SHA, '../secrets'],
			[SHA, 'a//b'],
			[SHA, ''],
			['main', 'src/a.js'],
			[SHA, `${'x/'.repeat(600)}a`]
		])
			await assert.rejects(reader.file('o', 'r', sha, path), /isn’t a file in a pull request/);
		await assert.rejects(reader.file('o/x', 'r', SHA, 'a'), /isn’t a file/);
		assert.equal(gh.calls.length, 0);
	});

	it('refuses a file too big to show', async () => {
		const gh = fakeGitHub({
			[`https://raw.example/o/r/${SHA}/big.txt`]: 'x'.repeat(1024 * 1024 + 1)
		});
		const reader = createGitHubReader({ fetch: gh.fetch, raw: 'https://raw.example' });
		await assert.rejects(reader.file('o', 'r', SHA, 'big.txt'), /too big/);
	});

	it('describes the project: the repo, and the start of its README', async () => {
		const gh = fakeGitHub({
			'https://api.example/repos/o/r': {
				html_url: 'https://github.com/o/r',
				description: 'Tricks.',
				language: 'TypeScript',
				topics: ['a', 'b'],
				stargazers_count: 12,
				default_branch: 'trunk'
			},
			'https://raw.example/o/r/trunk/readme.md': `# r\n\n${'words '.repeat(2000)}`
		});
		const reader = createGitHubReader({
			fetch: gh.fetch,
			api: 'https://api.example',
			raw: 'https://raw.example'
		});
		const p = await reader.project('o', 'r');
		assert.equal(p.description, 'Tricks.');
		assert.equal(p.branch, 'trunk');
		assert.deepEqual(p.topics, ['a', 'b']);
		assert.equal(p.readme.length, 6000, 'only the start of a long README');
		assert.ok(gh.calls.includes('https://raw.example/o/r/trunk/README.md'), 'README.md first');
		await assert.rejects(reader.project('o', '..x/y'), /isn’t a GitHub repository/);
	});
});
