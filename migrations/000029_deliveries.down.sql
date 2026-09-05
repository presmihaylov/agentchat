DROP TABLE deliveries;
ALTER TABLE rooms DROP COLUMN delivery_dead_letter_days, DROP COLUMN delivery_max_attempts;
