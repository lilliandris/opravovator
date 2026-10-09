-- administrátori podľa e-mailu (fungujú aj pre ľudí, ktorí sa ešte neprihlásili)
CREATE TABLE admins (
  email       TEXT PRIMARY KEY,
  added_by    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO admins (email) VALUES ('patrik.bukovsky@trojsten.sk');

-- posledné prihlásenie (created_at = prvé prihlásenie)
ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ;
UPDATE users SET last_login_at = created_at;

-- čo ľudia robia; task_id bez cudzieho kľúča, aby záznam ostal aj po zmazaní úlohy
CREATE TABLE activity_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  task_id     INTEGER,
  task_name   TEXT,
  details     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX activity_log_at ON activity_log(id DESC);
CREATE INDEX activity_log_user ON activity_log(user_id, id DESC);
