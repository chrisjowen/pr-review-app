#!/usr/bin/env node
/**
 * Regenerates a pre-generated demo review in `seed/`: opens the PR in the
 * shared engine, runs every stage on a live model, and writes the finished
 * review to `seed/<owner>__<repo>__<number>.json`. Every user gets a copy, so
 * the demo can be tried end to end at no cost.
 *
 *   OPENROUTER_API_KEY=… node scripts/seed.js https://github.com/chrisjowen/docket/pull/48
 *
 * PRREVIEW_SEED_MODEL picks the model (OpenRouter's naming; a stronger one
 * than the free allowance's, since the demo is the first thing people see).
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenAI } from 'pr-review-wheelhouse/wheelhouse/engine/model.js';
import { createReviews } from 'pr-review-wheelhouse/wheelhouse/engine/review.js';
import { memoryStore } from 'pr-review-wheelhouse/wheelhouse/engine/store.js';
import { createGitHubReader } from '../src/github.js';

const url = process.argv[2];
const apiKey = process.env.OPENROUTER_API_KEY;
if (!url || !apiKey) {
	process.stderr.write('Usage: OPENROUTER_API_KEY=… node scripts/seed.js <pull request URL>\n');
	process.exit(2);
}
const log = (line) => process.stderr.write(`${line}\n`);
const model = createOpenAI({
	baseUrl: 'https://openrouter.ai/api/v1',
	apiKey,
	model: process.env.PRREVIEW_SEED_MODEL || 'anthropic/claude-sonnet-5.5',
	maxTokens: 16_384,
	headers: { 'x-title': 'PR review for humans (demo seed)' }
});
const reviews = createReviews({
	github: createGitHubReader({ token: process.env.PRREVIEW_GITHUB_TOKEN || '', log }),
	store: memoryStore(),
	model: () => model,
	log
});

const { id } = await reviews.open(url);
const busy = (r) =>
	Object.values(r.runs).some((x) => x.state === 'queued' || x.state === 'running');
// The walkthrough plans the stops, then the rest run; wait until nothing is left to do.
do await reviews.settled();
while (busy(reviews.view(id)));
const r = reviews.view(id);
const failed = Object.entries(r.runs).filter(([, x]) => x.state !== 'done');
if (failed.length) {
	log(
		`Not every stage finished: ${failed.map(([id, x]) => `${id} (${x.state}: ${x.error ?? ''})`).join(', ')}`
	);
	process.exit(1);
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed', `${r.id}.json`);
writeFileSync(out, `${JSON.stringify(r, null, '\t')}\n`);
reviews.stop();
log(`Wrote ${out}: ${r.stages.length} stages.`);
