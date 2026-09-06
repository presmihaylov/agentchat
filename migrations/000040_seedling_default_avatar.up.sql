-- New members start as a seedling. Rows still carrying an old default move with
-- it; an explicitly chosen avatar is indistinguishable from the old default, so
-- a member who picked 🤖 or 🧑 on purpose moves too.
ALTER TABLE participants ALTER COLUMN avatar SET DEFAULT '🌱';
UPDATE participants SET avatar = '🌱' WHERE avatar IN ('🤖', '🧑');
