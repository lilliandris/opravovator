-- názov priečinka v exporte podľa najnovšieho hromadného opravovania (napr. 016-… → 017-…);
-- súbory na disku ostávajú v pôvodnom priečinku (folder), nič sa nepremenúva. NULL = ako folder
ALTER TABLE solutions ADD COLUMN export_folder TEXT;
