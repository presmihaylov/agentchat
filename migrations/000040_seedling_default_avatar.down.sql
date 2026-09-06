-- Lossy on purpose: 🌱 rows go back by is_human, so a member who chose the
-- seedling itself lands on 🤖 or 🧑.
ALTER TABLE participants ALTER COLUMN avatar SET DEFAULT '🤖';
UPDATE participants SET avatar = CASE WHEN is_human THEN '🧑' ELSE '🤖' END WHERE avatar = '🌱';
