"use client"

import { useState, useEffect, useCallback, useRef } from "react"

export interface CurrentUser {
  id: string
  username: string
  email: string
  avatar_url: string | null
  level: number
  xp: number
  streak_days: number
  longest_streak: number
  chapters_read: number
  bio: string | null
  safe_browsing_mode: "sfw" | "sfw_plus" | "nsfw"
  safe_browsing_indicator: "toggle" | "icon" | "hidden"
  default_source: string | null
  notification_digest?: "immediate" | "short" | "hourly" | "daily"
  privacy_settings?: Record<string, boolean>
  notification_settings?: Record<string, boolean>
  library_count?: number
  followers_count?: number
  following_count?: number
  _synced?: boolean
  _warning?: string
}

// Simple in-memory cache for deduplicated requests
interface CacheEntry {
  data: CurrentUser | null
  timestamp: number
  promise: Promise<CurrentUser | null> | null
}

const CACHE_TTL = 30000 // 30 seconds
const FETCH_TIMEOUT = 20000 // 20 second timeout (increased for slower environments)
const MAX_RETRIES = 3
const BASE_RETRY_DELAY_MS = 1000 // 1s, 2s, 4s exponential backoff

const userCache: CacheEntry = {
  data: null,
  timestamp: 0,
  promise: null
}

/**
 * Fetch with timeout to prevent hanging requests
 */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  
  try {
      const response = await fetch(url, { signal: controller.signal, credentials: 'include' })
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Exponential backoff delay: 500ms, 1000ms, 2000ms, ...
 */
function getRetryDelay(attempt: number): number {
  return BASE_RETRY_DELAY_MS * Math.pow(2, attempt)
}

/**
 * Shared fetch function - prevents duplicate in-flight requests
 * Uses deduplication to ensure only one request is active at a time.
 * Retries transient failures (5xx, timeouts) with exponential backoff.
 */
async function fetchCurrentUser(): Promise<CurrentUser | null> {
  const now = Date.now()
  
  // Return cached data if fresh
  if (userCache.data && now - userCache.timestamp < CACHE_TTL) {
    return userCache.data
  }
  
  // If a request is already in flight, wait for it
  if (userCache.promise) {
    return userCache.promise
  }
  
  // Start new request with retry logic
  userCache.promise = (async () => {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetchWithTimeout("/api/users/me", FETCH_TIMEOUT)
        
        if (res.status === 401) {
          // User not authenticated - cache this state, no retry
          userCache.data = null
          userCache.timestamp = Date.now()
          return null
        }
        
        // Retry on server errors (5xx) if attempts remain
        if (res.status >= 500 && attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, getRetryDelay(attempt)))
          continue
        }
        
        if (!res.ok) {
          // Non-retryable client error or final attempt - return stale data
          console.warn(`[useCurrentUser] API returned ${res.status}`)
          return userCache.data
        }
        
        const data = await res.json()
        const fetchTime = Date.now()
        
        // Only cache fully synced data
        if (data._synced !== false) {
          userCache.data = data
          userCache.timestamp = fetchTime
        } else if (!userCache.data) {
          // Use fallback data only if no cached data exists
          // Set shorter TTL to encourage retry
          userCache.data = data
          userCache.timestamp = fetchTime - (CACHE_TTL - 5000)
        } else {
          // We have cached data and got a fallback - prefer cached data
          // but update the timestamp to allow eventual refresh
          userCache.timestamp = fetchTime - (CACHE_TTL - 10000)
          return userCache.data
        }
        
        return data
      } catch (error: unknown) {
        // Handle timeout/abort - retry with backoff
        if (error instanceof Error && error.name === 'AbortError') {
          console.warn(`[useCurrentUser] Request timed out (attempt ${attempt + 1}/${MAX_RETRIES})`)
        }
        
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, getRetryDelay(attempt)))
          continue
        }
        
        // Final attempt failed - return stale data
        return userCache.data
      }
    }
    
    return userCache.data
  })()
  
  try {
    return await userCache.promise
  } finally {
    userCache.promise = null
  }
}

/**
 * Clear cache on logout
 * Call this when user logs out to ensure fresh state
 */
export function clearUserCache(): void {
  userCache.data = null
  userCache.timestamp = 0
  userCache.promise = null
}

/**
 * Invalidate cache to force refresh on next fetch
 * Does not clear existing data, just marks it stale
 */
export function invalidateUserCache(): void {
  userCache.timestamp = 0
}

/**
 * Hook to get the current authenticated user
 * Features:
 * - Request deduplication (multiple components share one request)
 * - In-memory caching with 30s TTL
 * - Graceful error handling with stale data fallback
 * - Timeout protection (10s max)
 */
export function useCurrentUser() {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    invalidateUserCache()
    try {
      const data = await fetchCurrentUser()
      if (mountedRef.current) {
        setUser(data)
        setError(null)
      }
    } catch {
      if (mountedRef.current) {
        setError("Failed to fetch user")
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    
    async function load() {
      try {
        const data = await fetchCurrentUser()
        if (mountedRef.current) {
          setUser(data)
          // FIX: Don't show error if we have user data - just log it
          // The _synced flag is shown separately in the UI
          if (data?._synced === false) {
            console.warn('[useCurrentUser] Using fallback data:', data._warning)
            // Don't set error - we have usable data
            setError(null)
          } else {
            setError(null)
          }
        }
      } catch {
        if (mountedRef.current) {
          setError("Connection error")
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false)
        }
      }
    }
    
    load()
    
    return () => {
      mountedRef.current = false
    }
  }, [])

  return { 
    user, 
    loading, 
    error, 
    refresh, 
    isAuthenticated: !!user 
  }
}
