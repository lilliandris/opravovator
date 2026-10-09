-- nasadené verzie aplikácie (čas = prvý štart servera s touto verziou)
CREATE TABLE IF NOT EXISTS releases (
  version     TEXT PRIMARY KEY,
  deployed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- kedy sa používateľ prihlásil (na tlačidlo „Aktualizácia“: nová verzia od prihlásenia)
ALTER TABLE sessions ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- kedy si naposledy pozrel zoznam zmien
ALTER TABLE users ADD COLUMN changelog_seen_at TIMESTAMPTZ;
