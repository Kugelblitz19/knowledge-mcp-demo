-- Knowledge base schema. Applied by `npm run db:start`. Additive only: nothing here drops or rewrites data.

CREATE TABLE IF NOT EXISTS staff (
  id    text PRIMARY KEY,
  name  text NOT NULL,
  role  text NOT NULL,
  team  text NOT NULL,
  email text NOT NULL
);

CREATE TABLE IF NOT EXISTS publications (
  id           text PRIMARY KEY,
  title        text NOT NULL,
  summary      text NOT NULL,
  topic        text NOT NULL,
  published_on date NOT NULL,
  author_id    text NOT NULL REFERENCES staff (id),
  url          text NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id        text PRIMARY KEY,
  title     text NOT NULL,
  starts_on date NOT NULL,
  location  text NOT NULL,
  owner_id  text NOT NULL REFERENCES staff (id)
);

-- One row per run of the nightly sync, successful or not.
CREATE TABLE IF NOT EXISTS sync_runs (
  id                 serial PRIMARY KEY,
  started_at         timestamptz NOT NULL,
  finished_at        timestamptz NOT NULL,
  status             text NOT NULL CHECK (status IN ('ok', 'failed')),
  source_exported_at timestamptz,
  rows_read          integer NOT NULL DEFAULT 0,
  rows_upserted      integer NOT NULL DEFAULT 0,
  skipped_ids        text[] NOT NULL DEFAULT '{}',
  error              text
);

CREATE INDEX IF NOT EXISTS publications_published_on_idx ON publications (published_on DESC);
CREATE INDEX IF NOT EXISTS sync_runs_finished_at_idx ON sync_runs (finished_at DESC);
