-- rýchle hľadanie, v ktorých riešeniach je použitý obrázok (kontrola prístupu k obrázkom)
CREATE INDEX solutions_annotations_gin ON solutions USING gin (annotations jsonb_path_ops);
