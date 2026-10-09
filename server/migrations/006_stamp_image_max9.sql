-- podpis pod bodmi ako obrázok (id z assets, NULL = textový podpis)
ALTER TABLE users ADD COLUMN stamp_image INTEGER;
-- maximum bodov je v seminári vždy 9
ALTER TABLE tasks ALTER COLUMN max_points SET DEFAULT 9;
UPDATE tasks SET max_points = 9 WHERE max_points IS NULL;
