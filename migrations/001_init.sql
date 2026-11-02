-- Users signed in with GitHub (or, on a local machine only, a demo login).
CREATE TABLE users (
	id bigserial PRIMARY KEY,
	github_id bigint UNIQUE,
	login text NOT NULL,
	name text NOT NULL DEFAULT '',
	kind text NOT NULL CHECK (kind IN ('github', 'demo')),
	created_at timestamptz NOT NULL DEFAULT now(),
	last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- A key a user brings, sealed (AES-256-GCM, bound to the user's id); never stored in the clear.
CREATE TABLE user_keys (
	user_id bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	provider text NOT NULL,
	model text NOT NULL,
	sealed text NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- The engine's records for each user: their reviews and their prompts.
CREATE TABLE reviews (
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	id text NOT NULL,
	review jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, id)
);

CREATE TABLE user_prompts (
	user_id bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	prompts jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every call on the free allowance: reserved before the call, settled after it.
-- Users are never deleted (only what is kept for them), so the ledger can't be reset.
CREATE TABLE ai_spend (
	id bigserial PRIMARY KEY,
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
	day date NOT NULL,
	state text NOT NULL CHECK (state IN ('reserved', 'settled')),
	reserved_usd numeric(12, 6) NOT NULL,
	cost_usd numeric(12, 6),
	model text NOT NULL,
	prompt_tokens integer,
	output_tokens integer,
	created_at timestamptz NOT NULL DEFAULT now(),
	settled_at timestamptz
);
CREATE INDEX ai_spend_day ON ai_spend (day);
CREATE INDEX ai_spend_user_day ON ai_spend (user_id, day);

-- Stage answers from the server's model, by a hash of exactly what was asked,
-- so the same PR head reviewed with the same prompts costs nothing the second time.
CREATE TABLE ai_cache (
	key text PRIMARY KEY,
	model text NOT NULL,
	answer jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);
