-- čas poslednej zmeny nastavení úlohy (zoznam úloh ukazuje poslednú zmenu, nie vytvorenie)
ALTER TABLE tasks ADD COLUMN updated_at TIMESTAMPTZ;
-- koľko zmien (pridané / upravené / zmazané objekty, bodovanie) obsahuje verzia
ALTER TABLE solution_versions ADD COLUMN changes INTEGER NOT NULL DEFAULT 0;
