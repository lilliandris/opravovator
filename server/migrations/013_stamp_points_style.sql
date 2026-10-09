-- stále rovnaký štýl bodov v PDF (pečiatka): písmo, farba, veľkosť; NULL = podľa práve nastaveného pera
ALTER TABLE users ADD COLUMN stamp_points_font TEXT;
ALTER TABLE users ADD COLUMN stamp_points_color TEXT;
ALTER TABLE users ADD COLUMN stamp_points_size DOUBLE PRECISION;
