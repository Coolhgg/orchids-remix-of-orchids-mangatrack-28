-- Migration: Remove legacy Chapter table
-- Date: 2026-02-05
-- Reason: The 'chapters' table is empty (0 rows) and has been replaced by 'logical_chapters'
-- All code has been migrated to use LogicalChapter model

-- Safety check: Only proceed if table is empty
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM chapters) > 0 THEN
    RAISE EXCEPTION 'chapters table is not empty - aborting migration';
  END IF;
END $$;

-- Drop indexes first
DROP INDEX IF EXISTS chapters_first_seen_at_desc;
DROP INDEX IF EXISTS chapters_first_seen_at_desc_id_desc;
DROP INDEX IF EXISTS chapters_published_at_desc_id_desc;
DROP INDEX IF EXISTS chapters_published_at_desc_series_id;
DROP INDEX IF EXISTS chapters_series_id_chapter_number_desc;
DROP INDEX IF EXISTS chapters_series_id_published_at_desc;

-- Drop the table
DROP TABLE IF EXISTS chapters;

-- Add comment to logical_chapters to indicate it's the canonical source
COMMENT ON TABLE logical_chapters IS 'Primary source of truth for chapter data. Replaced legacy chapters table as of 2026-02-05.';
