#!/usr/bin/env node
/**
 * PR review for humans: the web app. The shared review engine (from
 * pr-review-wheelhouse) behind a public web shell, with its own Postgres.
 * Configuration is the environment; see config.js.
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { checkPrices, readConfig } from './config.js';
import { createDb, migrate, waitFor } from './db.js';
import { createEngines, readSeeds } from './engines.js';
import { createGitHubReader } from './github.js';
import { createPoster } from './post.js';
import { pgCache } from './reviewer.js';
import { createSealer } from './seal.js';
import { createSpend } from './spend.js';
import { createUsers } from './users.js';

const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
const version = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

const config = readConfig();
const auth = createAuth({
	secret: config.sessionSecret,
	origin: config.origin,
	github: config.github,
	demo: config.demoLogin
});
const db = createDb({ url: config.databaseUrl });
await waitFor(db, { log });
const applied = await migrate(db);
if (applied.length) log(`migrations applied: ${applied.join(', ')}`);
const ai = await checkPrices(config.ai, { log });
const users = createUsers({ db, sealer: createSealer(config.sealKey) });
const spend = createSpend({ db, caps: config.caps });
const github = createGitHubReader({ token: config.github.token, log });
const seeds = readSeeds(config.seedDir);
const poster = createPoster({
	users,
	auth,
	api: config.github.apiUrl || undefined,
	appSlug: config.github.appSlug,
	log
});
const engines = createEngines({
	db,
	users,
	spend,
	cache: pgCache(db),
	github,
	poster,
	ai,
	seeds,
	version,
	log
});
const app = createApp({
	origin: config.origin,
	demoPr: config.demoPr,
	caps: config.caps,
	aiOn: !!ai,
	db,
	auth,
	users,
	spend,
	engines,
	github,
	seeds,
	log
});

const server = createServer((req, res) => void app.handle(req, res));
server.listen(config.port, () =>
	log(
		`pr-review-app ${version} on :${config.port} as ${config.origin} (sign-in: ${auth.github ? 'github' : 'off'}${auth.demo ? ' + demo' : ''}; github token: ${config.github.token ? 'yes' : 'no'}; free allowance: ${ai ? `${ai.model}, $${config.caps.userUsd}/user, $${config.caps.globalUsd}/day` : 'off'}; ${seeds.length} demo reviews)`
	)
);

let quitting = false;
async function quit() {
	if (quitting) return;
	quitting = true;
	server.close();
	setTimeout(() => process.exit(0), 8000).unref();
	await engines.close().catch((e) => log(`closing engines: ${e.message}`));
	await db.end().catch(() => {});
	process.exit(0);
}
process.on('SIGTERM', () => void quit());
process.on('SIGINT', () => void quit());
