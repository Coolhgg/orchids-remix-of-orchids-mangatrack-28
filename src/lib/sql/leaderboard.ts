import { prisma } from "@/lib/prisma"
import { logger } from "@/lib/logger"

/**
 * QA FIX BUG-004: Safe BigInt to Number conversion with overflow protection
 * PostgreSQL ROW_NUMBER() returns BigInt which can overflow Number.MAX_SAFE_INTEGER.
 * This helper safely converts to Number, capping at MAX_SAFE_INTEGER.
 */
function safeNumberConvert(value: bigint | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  
  // Handle BigInt specifically
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        logger.warn(`[Leaderboard] Value overflow detected: ${value} > MAX_SAFE_INTEGER`);
      return Number.MAX_SAFE_INTEGER;
    }
    if (value < BigInt(Number.MIN_SAFE_INTEGER)) {
      logger.warn(`[Leaderboard] Value underflow detected: ${value} < MIN_SAFE_INTEGER`);
      return Number.MIN_SAFE_INTEGER;
    }
    return Number(value);
  }
  
  // Handle numeric strings (common from DB results)
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? 0 : parsed;
  }
  
  // Handle regular numbers
  return typeof value === 'number' ? value : 0;
}

export interface LeaderboardEntry {
  rank: number
  id: string
  username: string
  avatar_url: string | null
  xp: number
  level: number
  streak_days: number
  chapters_read: number
  season_xp: number
  effective_xp: number
}

export interface SeasonalLeaderboardEntry extends LeaderboardEntry {
  season_id: string
  season_code: string
}

export const LEADERBOARD_QUERIES = {
  SEASONAL: `
    SELECT
      ROW_NUMBER() OVER (ORDER BY (us.xp * u.trust_score) DESC) AS rank,
      u.id,
      u.username,
      u.avatar_url,
      u.xp,
      u.level,
      u.streak_days,
      u.chapters_read,
      us.xp AS season_xp,
      FLOOR(us.xp * u.trust_score) AS effective_xp,
      s.id AS season_id,
      s.code AS season_code
    FROM user_season_xp us
    JOIN users u ON u.id = us.user_id
    JOIN seasons s ON s.id = us.season_id
    WHERE s.is_active = true
      AND u.deleted_at IS NULL
    ORDER BY effective_xp DESC
    LIMIT $1
  `,

  SEASONAL_BY_CODE: `
    SELECT
      ROW_NUMBER() OVER (ORDER BY (us.xp * u.trust_score) DESC) AS rank,
      u.id,
      u.username,
      u.avatar_url,
      u.xp,
      u.level,
      u.streak_days,
      u.chapters_read,
      us.xp AS season_xp,
      FLOOR(us.xp * u.trust_score) AS effective_xp,
      s.id AS season_id,
      s.code AS season_code
    FROM user_season_xp us
    JOIN users u ON u.id = us.user_id
    JOIN seasons s ON s.id = us.season_id
    WHERE s.code = $1
      AND u.deleted_at IS NULL
    ORDER BY effective_xp DESC
    LIMIT $2
  `,

  ALL_TIME: `
    SELECT
      ROW_NUMBER() OVER (ORDER BY (u.xp * u.trust_score) DESC) AS rank,
      u.id,
      u.username,
      u.avatar_url,
      u.xp,
      u.level,
      u.streak_days,
      u.chapters_read,
      u.season_xp,
      FLOOR(u.xp * u.trust_score) AS effective_xp
    FROM users u
    WHERE u.deleted_at IS NULL
      AND u.xp > 0
    ORDER BY effective_xp DESC
    LIMIT $1
  `,

  STREAK: `
    SELECT
      ROW_NUMBER() OVER (ORDER BY u.streak_days DESC) AS rank,
      u.id,
      u.username,
      u.avatar_url,
      u.xp,
      u.level,
      u.streak_days,
      u.chapters_read,
      u.season_xp,
      u.xp AS effective_xp
    FROM users u
    WHERE u.deleted_at IS NULL
      AND u.streak_days > 0
    ORDER BY u.streak_days DESC
    LIMIT $1
  `,

  CHAPTERS: `
    SELECT
      ROW_NUMBER() OVER (ORDER BY u.chapters_read DESC) AS rank,
      u.id,
      u.username,
      u.avatar_url,
      u.xp,
      u.level,
      u.streak_days,
      u.chapters_read,
      u.season_xp,
      u.xp AS effective_xp
    FROM users u
    WHERE u.deleted_at IS NULL
      AND u.chapters_read > 0
    ORDER BY u.chapters_read DESC
    LIMIT $1
  `,

  EFFICIENCY: `
    SELECT
      ROW_NUMBER() OVER (ORDER BY (FLOOR(u.xp * u.trust_score) / GREATEST(u.active_days, 1)) DESC) AS rank,
      u.id,
      u.username,
      u.avatar_url,
      u.xp,
      u.level,
      u.streak_days,
      u.chapters_read,
      u.season_xp,
      FLOOR(u.xp * u.trust_score) AS effective_xp,
      ROUND((u.xp * u.trust_score) / GREATEST(u.active_days, 1)::numeric, 2) AS xp_per_day
    FROM users u
    WHERE u.deleted_at IS NULL
      AND u.xp > 0
      AND u.active_days > 0
    ORDER BY xp_per_day DESC
    LIMIT $1
  `,

  USER_RANK_ALL_TIME: `
    SELECT rank FROM (
      SELECT
        u.id,
        ROW_NUMBER() OVER (ORDER BY (u.xp * u.trust_score) DESC) AS rank
      FROM users u
      WHERE u.deleted_at IS NULL AND u.xp > 0
    ) ranked
    WHERE id = $1
  `,

  USER_RANK_SEASONAL: `
    SELECT rank FROM (
      SELECT
        us.user_id AS id,
        ROW_NUMBER() OVER (ORDER BY (us.xp * u.trust_score) DESC) AS rank
      FROM user_season_xp us
      JOIN users u ON u.id = us.user_id
      JOIN seasons s ON s.id = us.season_id
      WHERE s.is_active = true AND u.deleted_at IS NULL
    ) ranked
    WHERE id = $1
  `,
} as const

export async function getSeasonalLeaderboard(limit: number = 100): Promise<SeasonalLeaderboardEntry[]> {
  const results = await prisma.$queryRawUnsafe<SeasonalLeaderboardEntry[]>(
    LEADERBOARD_QUERIES.SEASONAL,
    limit
  )
  // QA FIX BUG-004: Use safe BigInt conversion for all numeric fields
  return results.map(r => ({
    ...r,
    rank: safeNumberConvert(r.rank),
    xp: safeNumberConvert(r.xp),
    level: safeNumberConvert(r.level),
    streak_days: safeNumberConvert(r.streak_days),
    chapters_read: safeNumberConvert(r.chapters_read),
    season_xp: safeNumberConvert(r.season_xp),
    effective_xp: safeNumberConvert(r.effective_xp),
  }))
}

export async function getSeasonalLeaderboardByCode(
  seasonCode: string,
  limit: number = 100
): Promise<SeasonalLeaderboardEntry[]> {
  const results = await prisma.$queryRawUnsafe<SeasonalLeaderboardEntry[]>(
    LEADERBOARD_QUERIES.SEASONAL_BY_CODE,
    seasonCode,
    limit
  )
  // QA FIX BUG-004: Use safe BigInt conversion for all numeric fields
  return results.map(r => ({
    ...r,
    rank: safeNumberConvert(r.rank),
    xp: safeNumberConvert(r.xp),
    level: safeNumberConvert(r.level),
    streak_days: safeNumberConvert(r.streak_days),
    chapters_read: safeNumberConvert(r.chapters_read),
    season_xp: safeNumberConvert(r.season_xp),
    effective_xp: safeNumberConvert(r.effective_xp),
  }))
}

export async function getAllTimeLeaderboard(limit: number = 100): Promise<LeaderboardEntry[]> {
  const results = await prisma.$queryRawUnsafe<LeaderboardEntry[]>(
    LEADERBOARD_QUERIES.ALL_TIME,
    limit
  )
  // QA FIX BUG-004: Use safe BigInt conversion for all numeric fields
  return results.map(r => ({
    ...r,
    rank: safeNumberConvert(r.rank),
    xp: safeNumberConvert(r.xp),
    level: safeNumberConvert(r.level),
    streak_days: safeNumberConvert(r.streak_days),
    chapters_read: safeNumberConvert(r.chapters_read),
    season_xp: safeNumberConvert(r.season_xp),
    effective_xp: safeNumberConvert(r.effective_xp),
  }))
}

export async function getStreakLeaderboard(limit: number = 100): Promise<LeaderboardEntry[]> {
  const results = await prisma.$queryRawUnsafe<LeaderboardEntry[]>(
    LEADERBOARD_QUERIES.STREAK,
    limit
  )
  // QA FIX BUG-004: Use safe BigInt conversion for all numeric fields
  return results.map(r => ({
    ...r,
    rank: safeNumberConvert(r.rank),
    xp: safeNumberConvert(r.xp),
    level: safeNumberConvert(r.level),
    streak_days: safeNumberConvert(r.streak_days),
    chapters_read: safeNumberConvert(r.chapters_read),
    season_xp: safeNumberConvert(r.season_xp),
    effective_xp: safeNumberConvert(r.effective_xp),
  }))
}

export async function getChaptersLeaderboard(limit: number = 100): Promise<LeaderboardEntry[]> {
  const results = await prisma.$queryRawUnsafe<LeaderboardEntry[]>(
    LEADERBOARD_QUERIES.CHAPTERS,
    limit
  )
  // QA FIX BUG-004: Use safe BigInt conversion for all numeric fields
  return results.map(r => ({
    ...r,
    rank: safeNumberConvert(r.rank),
    xp: safeNumberConvert(r.xp),
    level: safeNumberConvert(r.level),
    streak_days: safeNumberConvert(r.streak_days),
    chapters_read: safeNumberConvert(r.chapters_read),
    season_xp: safeNumberConvert(r.season_xp),
    effective_xp: safeNumberConvert(r.effective_xp),
  }))
}

export async function getEfficiencyLeaderboard(limit: number = 100): Promise<(LeaderboardEntry & { xp_per_day: number })[]> {
  const results = await prisma.$queryRawUnsafe<(LeaderboardEntry & { xp_per_day: number })[]>(
    LEADERBOARD_QUERIES.EFFICIENCY,
    limit
  )
  // QA FIX BUG-004: Use safe BigInt conversion for all numeric fields
  return results.map(r => ({
    ...r,
    rank: safeNumberConvert(r.rank),
    xp: safeNumberConvert(r.xp),
    level: safeNumberConvert(r.level),
    streak_days: safeNumberConvert(r.streak_days),
    chapters_read: safeNumberConvert(r.chapters_read),
    season_xp: safeNumberConvert(r.season_xp),
    effective_xp: safeNumberConvert(r.effective_xp),
    xp_per_day: safeNumberConvert(r.xp_per_day),
  }))
}

export async function getUserRank(userId: string, type: 'all-time' | 'seasonal' = 'all-time'): Promise<number | null> {
  const query = type === 'seasonal' 
    ? LEADERBOARD_QUERIES.USER_RANK_SEASONAL 
    : LEADERBOARD_QUERIES.USER_RANK_ALL_TIME
  
  const results = await prisma.$queryRawUnsafe<{ rank: bigint }[]>(query, userId)
  // QA FIX BUG-004: Use safe BigInt conversion for rank
  return results.length > 0 ? safeNumberConvert(results[0].rank) : null
}
