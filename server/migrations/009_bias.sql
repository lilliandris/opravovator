-- interné body [Správnosť, Úsilie, AI a podvádzanie] a interný komentár – len pre vedúcich, do PDF sa nedostanú
ALTER TABLE solutions ADD COLUMN bias JSONB NOT NULL DEFAULT '[0,5,5]';
ALTER TABLE solutions ADD COLUMN bias_comment TEXT NOT NULL DEFAULT '';
ALTER TABLE solution_versions ADD COLUMN bias JSONB NOT NULL DEFAULT '[0,5,5]';
ALTER TABLE solution_versions ADD COLUMN bias_comment TEXT NOT NULL DEFAULT '';
