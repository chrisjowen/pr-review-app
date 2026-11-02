-- A user's GitHub token, to post the reviews they confirm as them. Sealed like their keys
-- (AES-256-GCM, bound to the user's id); never stored in the clear.
CREATE TABLE user_github_tokens (
	user_id bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	sealed text NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
);
