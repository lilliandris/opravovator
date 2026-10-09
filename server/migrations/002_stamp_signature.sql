-- vlastný podpis pod bodmi: prezývka a písmo (NULL = meno / rovnaké písmo ako body)
ALTER TABLE users ADD COLUMN stamp_name TEXT;
ALTER TABLE users ADD COLUMN stamp_font TEXT;
