-- Shared database: accounts and login. Per-user work items live in each user's Durable Object.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,            -- NULL for a guest until they sign in
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,  -- SHA-256 of the cookie token; the token itself is never stored
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX sessions_user_id ON sessions(user_id);
