# pr-review-app

PR review for humans, against agent-generated code. Swap `github.com` for `pr.chrisjowen.net` on any pull request:

```
https://github.com/chrisjowen/pr-review-wheelhouse/pull/3
https://pr.chrisjowen.net/chrisjowen/pr-review-wheelhouse/pull/3
```

- **The reading plan is public and free.** Any public PR, no sign-in and no AI: rules about paths and change sizes sort the files into _Read first_ (the biggest source changes, grouped by folder), _Skim_ (grouped by kind: small source changes, tests, config, docs, assets) and _Hidden_ (generated files such as lockfiles, build output, snapshots and minified bundles). Every file expands to its diff. GitHub's own PR tabs (`/files`, `/commits`, `/checks`) land on the same page.
- **The guided review needs Sign in with GitHub, and happens in a chat.** It runs on the same engine as the [pr-review-wheelhouse](https://github.com/chrisjowen/pr-review-wheelhouse) plugin. The reviewer opens with an overview of the PR (what it does, what needs your attention, what was asked and whether it's met), offers context on _the project as a whole_ or _the story_ behind the PR when the repo is new to you or the PR is large (a Context button is there either way), then walks the changes one at a time: the _Key changes_ a stop at a time, a _Quality pass_ that opens with every concern in the review as a checklist, and a _Skim pile_ (generated files last). Each change is one message: its main verdict and maybe a second one (Looks good, Explanation, Exemplary, Code smell, Possible security issue, Over-complex, Not well tested, Doesn't meet acceptance criteria, Performance risk), filed as _What I like_, _Worth knowing_, _Needs work_ or _Serious_ (the verdicts that block: security, acceptance criteria, tests, performance), the code with its key lines highlighted, a suggestion for problems, Accept / Disagree / Comment, and follow-up questions. Deciding moves on to the next change. Type anything to ask the reviewer about the change in front of you (a line number opens the file there too), or "next", "back", "finish". You can ask for a disagreement to be remembered (kept, for now, for a later memory feature).
- **Beside the chat, never instead of it,** the navigator lists the passage's groups and stops and every changed file (GitHub-style, with a filter), and Ctrl+E (⌘E on a Mac) opens a quick switcher; jumping anywhere moves the conversation there. Any file opens whole in a drawer at the right line, with its changes a tab away. The card view from the plugin is still at `…/review?view=cards`, with the prompt settings.
- **Finish review** drafts your verdict: Approve, Request changes or Comment, with the cards you accepted or commented on as inline comments. You see the draft, then either post it to the pull request as yourself or copy it as Markdown. A review is posted once per PR head: after that, Finish (or a reload) shows the posted review instead of offering to post again. GitHub doesn't let anyone approve or request changes on their own pull request, so there the review is posted as a comment, and the site says so. A comment on a line outside the diff goes in the review's body, with its file and lines.
- **AI costs.** Signed-in users get a small free AI allowance on the site's budget, with a hard daily cap per person and a hard daily cap for everyone. They can bring their own OpenRouter or OpenAI key for unlimited reviews. The model is swappable; the allowance runs on a cheap model through OpenRouter.

There's also a bookmarklet on the home page that opens the GitHub PR you're on here.

## How it works

The web app is a thin shell around the shared review engine, which it takes from `pr-review-wheelhouse` as a dependency (pinned by commit). The engine and its review tab are used unchanged:

- `src/app.js`: the routes, security headers (`script-src 'self'`), same-origin checks on every change, and the engine API proxy at `/engine/api/*`.
- `src/urls.js`: the URL swap, and reading whatever someone pastes.
- `src/plan.js` and `src/pages.js`: the public reading plan, rendered on the server, and the shells the review runs in.
- `static/chat.js` and `static/chat-core.js`: the review as a chat, in the browser. It talks to the engine's API for everything it keeps (the review and its deck of cards, the chat threads, your decisions, posting), so a reload picks up where you were; `chat-core.js` is its logic without the page (what a card says, the reading order, when to offer context, what a typed line means), tested in Node.
- `/<owner>/<repo>/pull/<n>/review/file` and `/review/context`: what the chat reads besides the engine, signed in only. One of the review's changed files whole at the head the review was made at, so it lines up with the review's diff (from GitHub's raw host; any other path is refused, so this is no proxy for the rest of GitHub), and the project's description, topics and the start of its README.
- `src/auth.js`: the signed session cookie (`__Host-` prefixed, `HttpOnly`, `SameSite=Lax`) and Sign in with GitHub through a GitHub App's user authorization. The user token (and its refresh token, when the App's tokens expire) is kept sealed, like your key, so a review you confirm can be posted as you. Signing out deletes it.
- `src/post.js`: posts a confirmed review as the signed-in user, renewing an expired token first. It turns a verdict on your own pull request into a comment, moves comments GitHub won't take inline into the body, and says how to fix a GitHub App that can't write reviews.
- `src/engines.js` and `src/store.js`: one engine per signed-in user. Its reviews and prompts are kept in Postgres, written a moment after each change.
- `src/reviewer.js` and `src/spend.js`: who reviews. With your own key, it's your provider and model, unmetered. Otherwise it's the free allowance. Before every call to the site's model, the call reserves the most it could cost: its prompt, plus its whole output budget (`max_tokens`). The reservation is refused if it would take you past your daily cap, or everyone past the global one. After the call it's settled at the real cost. A failed call, or one that never settled, counts in full, so the caps hold. Days are UTC. Stage answers are cached by exactly what was asked, so a second review of the same PR head with the default prompts costs nothing.
- `src/seal.js`: your key and GitHub token are sealed with AES-256-GCM under `PRREVIEW_SEAL_KEY`, bound to your user id. They're only unsealed to make your own calls.
- `src/github.js`: reads public PRs over GitHub's REST API. It caches for 90 seconds and serves stale data when the rate limit runs out. The diff comes from `github.com/<o>/<r>/pull/<n>.diff`, which isn't rate limited.
- `seed/`: two pre-generated demo reviews (chrisjowen/docket#48 and chrisjowen/pr-review-wheelhouse#3). Every user gets a copy, so every stage can be tried at no cost.

## Run it locally

You need Node 22 and a Postgres:

```sh
docker run -d --name prreview-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:17-alpine
npm install
export DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres
export PRREVIEW_SESSION_SECRET=$(openssl rand -hex 32) PRREVIEW_SEAL_KEY=$(openssl rand -hex 32)
npm run dev        # http://localhost:8080, with the local demo login
```

`npm run dev` turns on the demo login (`PRREVIEW_DEMO_LOGIN=1`): a throwaway identity, so you can try the guided review without a GitHub App. It's refused when the origin is https, so a deployed site can't have it. Add `OPENROUTER_API_KEY` to turn on the free allowance.

```sh
npm run lint
PRREVIEW_TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres npm test
```

The tests cover the URL mapping, the reading plan's grouping, the caps (including racing calls and the UTC day), the metered reviewer and its cache, sessions and Sign in with GitHub against a fake GitHub, key sealing, the Postgres store, and the whole site over HTTP. Without `PRREVIEW_TEST_DATABASE_URL`, the Postgres tests are skipped locally. In CI they always run.

## Configuration

All configuration comes from the environment. In the cluster, secrets live in a Kubernetes secret, never in the image or this repository. See `src/config.js` for the full list.

| Variable                                                         | What it does                                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                   | Postgres (required).                                                                                     |
| `PRREVIEW_SESSION_SECRET`                                        | Signs session cookies, 32+ characters (required).                                                        |
| `PRREVIEW_SEAL_KEY`                                              | Seals the keys users bring: `openssl rand -hex 32` (required).                                           |
| `PRREVIEW_ORIGIN`                                                | The site's origin, such as `https://pr.chrisjowen.net`.                                                  |
| `PRREVIEW_GITHUB_CLIENT_ID`, `PRREVIEW_GITHUB_CLIENT_SECRET`     | Sign in with GitHub (a GitHub App). Without them, sign-in is closed and the reading plan still works.    |
| `PRREVIEW_GITHUB_APP_SLUG`                                       | The GitHub App's slug, to link its install page when it can't post a review.                             |
| `PRREVIEW_GITHUB_TOKEN`                                          | A fine-grained token with public read-only access: 5,000 GitHub API calls an hour instead of 60.         |
| `OPENROUTER_API_KEY`                                             | Turns on the free AI allowance.                                                                          |
| `PRREVIEW_AI_MODEL`, `PRREVIEW_AI_LABEL`, `PRREVIEW_AI_BASE_URL` | The allowance's model (default `anthropic/claude-haiku-5.5` on OpenRouter).                              |
| `PRREVIEW_AI_PRICE_IN`, `PRREVIEW_AI_PRICE_OUT`                  | USD per million tokens, used to size reservations. On OpenRouter, the live price is used if it's higher. |
| `PRREVIEW_QUOTA_USER_USD`, `PRREVIEW_QUOTA_GLOBAL_USD`           | Hard daily caps: $0.25 per person and $10 for everyone by default.                                       |
| `PRREVIEW_DEMO_LOGIN=1`                                          | The local demo login (refused with an https origin).                                                     |

## Deploy

The site runs on a k3s cluster in the `pr-review` namespace. Postgres is a StatefulSet on a `local-path` volume; only the app and the backup job may connect to it. The app runs as a single replica, because each user's review engine lives in the process. Containers run as non-root with a read-only root filesystem and all capabilities dropped.

```sh
NODE=root@<k3s node> ./deploy/deploy.sh             # Postgres, nightly backups, the app
NODE=root@<k3s node> ./deploy/deploy.sh --ingress   # and route pr.chrisjowen.net to it
```

The script builds a `linux/amd64` image and imports it into the node's containerd over SSH, so no registry is needed. It creates the secrets once, on the cluster (`pr-review-db`, plus `pr-review-app` with a generated session secret and seal key), and rolls out the app. With `OPENROUTER_API_KEY` in its environment, the script adds that key to the secret.

Sign in with GitHub uses a GitHub App's user authorization. The site asks who you are, and posts the reviews you confirm as you, so the App needs:

- **Homepage URL:** `https://pr.chrisjowen.net`
- **Callback URL:** `https://pr.chrisjowen.net/auth/github/callback`
- **Permissions:** Repository, **Pull requests: Read and write**. **Webhook:** inactive. **Request user authorization (OAuth) during installation:** off.
- **Expire user authorization tokens:** either way. With expiring tokens, the site renews them with the refresh token.

A GitHub App's user token can only write where the App is installed, so posting works on repositories that have the App installed. Elsewhere, and before the permission is granted, posting says what's missing and the review can still be copied as Markdown. After the permission changes, sign out and sign in again.

Then add its client id and secret to the app's secret:

```sh
printf '{"stringData":{"PRREVIEW_GITHUB_CLIENT_ID":"%s","PRREVIEW_GITHUB_CLIENT_SECRET":"%s"}}' "$ID" "$SECRET" \
  | kubectl -n pr-review patch secret pr-review-app --type merge --patch-file /dev/stdin
kubectl -n pr-review rollout restart deploy/web
```

### Backups

The CronJob `postgres-backup` runs at 03:17 UTC every night. It writes a `pg_dump` to the `backups` volume on the node and keeps 14 days there. It then copies the dump off the node with rclone to `BACKUP_REMOTE`, keeping 30 days. The off-box target is configured only in the secret `pr-review-backup`; `deploy/k8s/backup.yaml` has an example with an S3-compatible bucket and an rclone `crypt` remote, which encrypts each dump before it leaves the node. Until that secret exists, the job fails at the off-box step, so a missing copy is visible.

To restore a dump:

```sh
kubectl -n pr-review exec -i postgres-0 -- pg_restore -U prreview -d prreview --clean --if-exists < prreview-<stamp>.dump
```

### Uptime

`.github/workflows/uptime.yml` checks `https://pr.chrisjowen.net/readyz` (the app and its Postgres) and the home page every 10 minutes from GitHub's runners. A failed run is the alert: GitHub notifies whoever last changed that schedule. GitHub pauses scheduled workflows in a repository that has had no activity for 60 days.

## License

MIT
