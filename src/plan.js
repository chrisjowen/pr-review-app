/**
 * The public PR page's reading plan: no AI, only the shared engine's rules
 * about paths and change sizes. *Read first* is the engine's heuristic stops
 * (the biggest source changes, grouped with their neighbours); *Skim* is the
 * rest grouped by kind; *Hidden* is generated files (lockfiles, build output,
 * snapshots, minified bundles). Every changed file lands in exactly one group.
 */

import { kindOf } from 'pr-review-wheelhouse/wheelhouse/engine/classify.js';
import { parseDiff } from 'pr-review-wheelhouse/wheelhouse/engine/diff.js';
import { heuristicPlan } from 'pr-review-wheelhouse/wheelhouse/engine/stages.js';

export const SKIM_KINDS = /** @type {const} */ (['source', 'test', 'config', 'docs', 'asset']);
export const KIND_LABEL = {
	source: 'Small source changes',
	test: 'Tests',
	config: 'Config',
	docs: 'Docs',
	asset: 'Assets'
};

/** The changed files of a unified diff, each with its kind. */
export function filesOf(diff) {
	return parseDiff(diff).map((f) => ({ ...f, kind: kindOf(f.path) }));
}

/**
 * @param {ReturnType<typeof filesOf>} files
 * @returns {{
 *   read: { title: string; why: string; files: any[] }[];
 *   skim: { kind: string; label: string; files: any[] }[];
 *   hidden: any[];
 *   counts: { read: number; skim: number; hidden: number };
 * }}
 */
export function readingPlan(files) {
	const plan = heuristicPlan(files);
	const byPath = new Map(files.map((f) => [f.path, f]));
	const read = plan.stops.map((s) => ({
		title: s.title,
		why: s.why,
		files: s.files.map((p) => byPath.get(p))
	}));
	const groups = new Map();
	for (const p of plan.skim) {
		const f = byPath.get(p);
		const kind = SKIM_KINDS.includes(f.kind) ? f.kind : 'source';
		if (!groups.has(kind)) groups.set(kind, []);
		groups.get(kind).push(f);
	}
	const skim = SKIM_KINDS.filter((k) => groups.has(k)).map((k) => ({
		kind: k,
		label: KIND_LABEL[k],
		files: groups.get(k)
	}));
	const hidden = plan.generated.map((p) => byPath.get(p));
	return {
		read,
		skim,
		hidden,
		counts: {
			read: read.reduce((n, s) => n + s.files.length, 0),
			skim: plan.skim.length,
			hidden: hidden.length
		}
	};
}
