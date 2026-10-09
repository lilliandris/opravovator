CREATE TABLE users (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  google_sub  TEXT UNIQUE,
  picture     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE tasks (
  id               SERIAL PRIMARY KEY,
  owner_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  root_folder      TEXT,
  comment_text     TEXT NOT NULL DEFAULT '',
  comment_filename TEXT NOT NULL,
  max_points       DOUBLE PRECISION,
  rubric           JSONB NOT NULL DEFAULT '[]',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tasks_owner ON tasks(owner_id);

-- zdieľanie podľa e-mailu, funguje aj pre ľudí, ktorí sa ešte neprihlásili
CREATE TABLE task_shares (
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, email)
);
CREATE INDEX task_shares_email ON task_shares(email);

CREATE TABLE solutions (
  id             SERIAL PRIMARY KEY,
  task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  idx            INTEGER NOT NULL,
  folder         TEXT NOT NULL,
  pdf_name       TEXT,
  display_name   TEXT NOT NULL,
  rocnik         TEXT NOT NULL DEFAULT '',
  student_id     TEXT NOT NULL DEFAULT '',
  had_points_file  BOOLEAN NOT NULL DEFAULT false,
  annotations    JSONB NOT NULL DEFAULT '[]',
  checks         JSONB NOT NULL DEFAULT '[]',
  manual_points  DOUBLE PRECISION,
  points         DOUBLE PRECISION,
  rev            INTEGER NOT NULL DEFAULT 0,
  rendered_rev   INTEGER NOT NULL DEFAULT -1,
  updated_at     TIMESTAMPTZ,
  updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX solutions_task ON solutions(task_id, idx);

-- história opráv; ukladanie v rýchlom slede od toho istého človeka sa zlúči do jednej verzie
CREATE TABLE solution_versions (
  id             SERIAL PRIMARY KEY,
  solution_id    INTEGER NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
  rev            INTEGER NOT NULL,
  annotations    JSONB NOT NULL,
  checks         JSONB NOT NULL,
  manual_points  DOUBLE PRECISION,
  points         DOUBLE PRECISION,
  rocnik         TEXT NOT NULL,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX solution_versions_sol ON solution_versions(solution_id, id DESC);

-- obrázky/podpisy; dáta sú na disku v DATA_DIR/assets
CREATE TABLE assets (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  deleted     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
