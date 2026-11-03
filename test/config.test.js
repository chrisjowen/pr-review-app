import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { frameAncestors, readConfig } from '../src/config.js';

const ENV = {
	DATABASE_URL: 'postgres://x@localhost/x',
	PRREVIEW_SEAL_KEY: '0'.repeat(63) + '1'
};

/** The CSP the site sends with a page, for the given frame-ancestors setting. */
async function cspOf(setting) {
	const app = createApp({
		origin: 'http://localhost:9',
		demoPr: 'https://github.com/chrisjowen/docket/pull/48',
		caps: { userUsd: 0.25, globalUsd: 10 },
		aiOn: false,
		db: {},
		auth: { github: false, demo: false },
		users: {},
		spend: {},
		engines: {},
		github: {},
		seeds: [],
		...(setting === undefined ? {} : { frameAncestors: setting })
	});
	const server = createServer((req, res) => void app.handle(req, res));
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	try {
		const res = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
		assert.equal(res.headers.get('x-frame-options'), null);
		return res.headers.get('content-security-policy');
	} finally {
		server.close();
	}
}

describe('who may frame the site', () => {
	it('is nobody unless origins are listed', async () => {
		assert.equal(readConfig(ENV).frameAncestors, "'none'");
		assert.equal(frameAncestors('  '), "'none'");
		assert.match(await cspOf(), /frame-ancestors 'none';/);
	});

	it('is the listed origins when set, for a local preview embedded in a tool', async () => {
		const list = 'http://127.0.0.1:4310 http://localhost:4310 http://*.localhost:4310';
		const config = readConfig({ ...ENV, PRREVIEW_FRAME_ANCESTORS: ` ${list} ` });
		assert.equal(config.frameAncestors, list);
		assert.match(
			await cspOf(config.frameAncestors),
			new RegExp(`frame-ancestors ${list.replaceAll('*', '\\*')};`)
		);
	});

	it('refuses anything that isn’t an origin, so the policy can’t be rewritten', () => {
		for (const bad of [
			"http://a.example; script-src 'unsafe-inline'",
			'*',
			'javascript:x',
			'http://a/b'
		])
			assert.throws(() => frameAncestors(bad), /PRREVIEW_FRAME_ANCESTORS/);
	});
});
