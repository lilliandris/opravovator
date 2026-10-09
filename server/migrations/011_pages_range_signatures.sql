-- strany výsledného PDF (pridané prázdne / otočené), NULL = ako v pôvodnom PDF
ALTER TABLE solutions ADD COLUMN pages JSONB;
ALTER TABLE solution_versions ADD COLUMN pages JSONB;
-- intervalové bodovanie: body za položky (id položky → body)
ALTER TABLE solutions ADD COLUMN scores JSONB NOT NULL DEFAULT '{}';
ALTER TABLE solution_versions ADD COLUMN scores JSONB NOT NULL DEFAULT '{}';
-- spôsob bodovania úlohy: 'checks' = zaškrtávanie, 'range' = intervaly
ALTER TABLE tasks ADD COLUMN rubric_mode TEXT NOT NULL DEFAULT 'checks';
-- zdieľaná úloha: čie podpisy idú pod body (id používateľov, prázdne = len toho, kto vkladá body)
ALTER TABLE tasks ADD COLUMN signers JSONB NOT NULL DEFAULT '[]';
-- farba textového podpisu a jeho poloha voči bodom
ALTER TABLE users ADD COLUMN stamp_color TEXT;
ALTER TABLE users ADD COLUMN stamp_pos TEXT;
