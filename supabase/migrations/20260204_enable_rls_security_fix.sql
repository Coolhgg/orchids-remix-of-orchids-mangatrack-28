-- Supabase Security Fix Migration
-- This migration enables RLS on tables that have policies but RLS disabled
-- and adds appropriate policies where missing

-- ============================================
-- CRITICAL: Enable RLS on tables with existing policies
-- ============================================

-- import_jobs: Has policies but RLS disabled (CRITICAL - user data)
ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;

-- ============================================
-- HIGH PRIORITY: User-related tables
-- ============================================

-- user_chapter_reads: Contains user reading history
ALTER TABLE public.user_chapter_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own chapter reads" ON public.user_chapter_reads
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own chapter reads" ON public.user_chapter_reads
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own chapter reads" ON public.user_chapter_reads
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Service role full access to user_chapter_reads" ON public.user_chapter_reads
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- login_attempts: Sensitive authentication data
ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for login_attempts" ON public.login_attempts
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- audit_logs: Sensitive audit data
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for audit_logs" ON public.audit_logs
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- user_affinities: User preferences
ALTER TABLE public.user_affinities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own affinities" ON public.user_affinities
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role full access to user_affinities" ON public.user_affinities
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- user_recommendations: User-specific recommendations
ALTER TABLE public.user_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own recommendations" ON public.user_recommendations
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role full access to user_recommendations" ON public.user_recommendations
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- user_signals: User behavior signals
ALTER TABLE public.user_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own signals" ON public.user_signals
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role full access to user_signals" ON public.user_signals
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- user_source_priorities: User preferences
ALTER TABLE public.user_source_priorities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own source priorities" ON public.user_source_priorities
  FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Service role full access to user_source_priorities" ON public.user_source_priorities
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- user_series_source_preferences: User preferences
ALTER TABLE public.user_series_source_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own series source preferences" ON public.user_series_source_preferences
  FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Service role full access to user_series_source_preferences" ON public.user_series_source_preferences
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- xp_transactions: User XP history
ALTER TABLE public.xp_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own xp transactions" ON public.xp_transactions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role full access to xp_transactions" ON public.xp_transactions
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- import_items: Part of import jobs
ALTER TABLE public.import_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own import items" ON public.import_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.import_jobs 
      WHERE import_jobs.id = import_items.import_job_id 
      AND import_jobs.user_id = auth.uid()
    )
  );
CREATE POLICY "Service role full access to import_items" ON public.import_items
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- ============================================
-- MEDIUM PRIORITY: Public/Internal data tables
-- ============================================

-- chapters: Public manga chapter data
ALTER TABLE public.chapters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Chapters are publicly readable" ON public.chapters
  FOR SELECT USING (true);
CREATE POLICY "Service role full access to chapters" ON public.chapters
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- chapter_sources: Public chapter source data
ALTER TABLE public.chapter_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Chapter sources are publicly readable" ON public.chapter_sources
  FOR SELECT USING (true);
CREATE POLICY "Service role full access to chapter_sources" ON public.chapter_sources
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- creators: Public creator data
ALTER TABLE public.creators ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Creators are publicly readable" ON public.creators
  FOR SELECT USING (true);
CREATE POLICY "Service role full access to creators" ON public.creators
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- series_creators: Public series-creator relationships
ALTER TABLE public.series_creators ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Series creators are publicly readable" ON public.series_creators
  FOR SELECT USING (true);
CREATE POLICY "Service role full access to series_creators" ON public.series_creators
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- series_relations: Public series relationships
ALTER TABLE public.series_relations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Series relations are publicly readable" ON public.series_relations
  FOR SELECT USING (true);
CREATE POLICY "Service role full access to series_relations" ON public.series_relations
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- series_stats: Public statistics
ALTER TABLE public.series_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Series stats are publicly readable" ON public.series_stats
  FOR SELECT USING (true);
CREATE POLICY "Service role full access to series_stats" ON public.series_stats
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- feed_entries: Public feed data
ALTER TABLE public.feed_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Feed entries are publicly readable" ON public.feed_entries
  FOR SELECT USING (true);
CREATE POLICY "Service role full access to feed_entries" ON public.feed_entries
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- logical_chapters: Public chapter groupings
ALTER TABLE public.logical_chapters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Logical chapters are publicly readable" ON public.logical_chapters
  FOR SELECT USING (true);
CREATE POLICY "Service role full access to logical_chapters" ON public.logical_chapters
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- mangaupdates_releases: Public release data
ALTER TABLE public.mangaupdates_releases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "MangaUpdates releases are publicly readable" ON public.mangaupdates_releases
  FOR SELECT USING (true);
CREATE POLICY "Service role full access to mangaupdates_releases" ON public.mangaupdates_releases
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- ============================================
-- LOW PRIORITY: Internal/System tables (service role only)
-- ============================================

-- source_configs: Internal configuration
ALTER TABLE public.source_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for source_configs" ON public.source_configs
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- sync_tasks: Internal sync queue
ALTER TABLE public.sync_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for sync_tasks" ON public.sync_tasks
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- scheduler_state: Internal scheduler
ALTER TABLE public.scheduler_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for scheduler_state" ON public.scheduler_state
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- worker_failures: Internal error tracking
ALTER TABLE public.worker_failures ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for worker_failures" ON public.worker_failures
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- notifications_queue: Internal queue
ALTER TABLE public.notifications_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for notifications_queue" ON public.notifications_queue
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- notification_digest_buffer: Internal buffer
ALTER TABLE public.notification_digest_buffer ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for notification_digest_buffer" ON public.notification_digest_buffer
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- data_operation_reports: Internal reports
ALTER TABLE public.data_operation_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for data_operation_reports" ON public.data_operation_reports
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- query_stats: Internal analytics
ALTER TABLE public.query_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for query_stats" ON public.query_stats
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- read_telemetry: Internal telemetry
ALTER TABLE public.read_telemetry ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for read_telemetry" ON public.read_telemetry
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- search_events: Internal analytics
ALTER TABLE public.search_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for search_events" ON public.search_events
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- trust_violations: Internal security
ALTER TABLE public.trust_violations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for trust_violations" ON public.trust_violations
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- ============================================
-- Availability/Events tables
-- ============================================

ALTER TABLE public.availability_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for availability_events" ON public.availability_events
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

ALTER TABLE public.chapter_availability ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Chapter availability is publicly readable" ON public.chapter_availability
  FOR SELECT USING (true);
CREATE POLICY "Service role full access to chapter_availability" ON public.chapter_availability
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

ALTER TABLE public.chapter_availability_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for chapter_availability_events" ON public.chapter_availability_events
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

ALTER TABLE public.series_activity_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only for series_activity_events" ON public.series_activity_events
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- ============================================
-- Seasonal/Achievement tables
-- ============================================

ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Seasons are publicly readable" ON public.seasons
  FOR SELECT USING (true);
CREATE POLICY "Service role full access to seasons" ON public.seasons
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

ALTER TABLE public.seasonal_user_achievements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own seasonal achievements" ON public.seasonal_user_achievements
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Public seasonal achievements are viewable" ON public.seasonal_user_achievements
  FOR SELECT USING (true);
CREATE POLICY "Service role full access to seasonal_user_achievements" ON public.seasonal_user_achievements
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

ALTER TABLE public.user_season_xp ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own season xp" ON public.user_season_xp
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role full access to user_season_xp" ON public.user_season_xp
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- ============================================
-- Seed list tables
-- ============================================

ALTER TABLE public.seed_lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Seed lists are publicly readable" ON public.seed_lists
  FOR SELECT USING (true);
CREATE POLICY "Service role full access to seed_lists" ON public.seed_lists
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

ALTER TABLE public.seed_list_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Seed list entries are publicly readable" ON public.seed_list_entries
  FOR SELECT USING (true);
CREATE POLICY "Service role full access to seed_list_entries" ON public.seed_list_entries
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- ============================================
-- User availability feed
-- ============================================

ALTER TABLE public.user_availability_feed ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own availability feed" ON public.user_availability_feed
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role full access to user_availability_feed" ON public.user_availability_feed
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');
