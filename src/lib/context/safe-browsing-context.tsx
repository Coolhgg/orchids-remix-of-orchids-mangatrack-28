"use client"

import { createContext, useContext, useState, useEffect, useCallback, ReactNode, useRef } from "react"
import { AgeVerificationModal } from "@/components/ui/age-verification-modal"
import {
  SafeBrowsingMode,
  SafeBrowsingIndicator,
  SAFE_BROWSING_STORAGE_KEY,
  SAFE_BROWSING_INDICATOR_STORAGE_KEY,
} from "@/lib/constants/safe-browsing"

interface SafeBrowsingContextValue {
  mode: SafeBrowsingMode
  indicator: SafeBrowsingIndicator
  isLoading: boolean
  isAuthenticated: boolean
  setMode: (mode: SafeBrowsingMode) => Promise<void>
  setIndicator: (indicator: SafeBrowsingIndicator) => Promise<void>
  cycleMode: () => void
}

const SafeBrowsingContext = createContext<SafeBrowsingContextValue | null>(null)

export function SafeBrowsingProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<SafeBrowsingMode>("sfw")
  const [indicator, setIndicatorState] = useState<SafeBrowsingIndicator>("toggle")
  const [isLoading, setIsLoading] = useState(true)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isAgeModalOpen, setIsAgeModalOpen] = useState(false)
  
  // FIX: Use a ref to avoid stale closure issues with the modal callback
  const pendingModeRef = useRef<SafeBrowsingMode | null>(null)

  useEffect(() => {
    let isMounted = true
    
    async function loadSettings() {
      // OPTIMIZATION: Try cached value first for instant UI
      const cachedMode = localStorage.getItem(SAFE_BROWSING_STORAGE_KEY) as SafeBrowsingMode | null
      const cachedIndicator = localStorage.getItem(SAFE_BROWSING_INDICATOR_STORAGE_KEY) as SafeBrowsingIndicator | null
      
      if (cachedMode && isMounted) {
        setModeState(cachedMode)
        setIndicatorState(cachedIndicator || "toggle")
        setIsAuthenticated(true)
        setIsLoading(false) // Show cached immediately
      }
      
      // Then fetch fresh data with retry logic
      let retryCount = 0
      const maxRetries = 3
      const baseDelay = 500
      
      while (retryCount <= maxRetries) {
        try {
          const res = await fetch("/api/users/me")
          
          if (!isMounted) return
          
          if (res.status === 401) {
            // User logged out - clear cache
            localStorage.removeItem(SAFE_BROWSING_STORAGE_KEY)
            localStorage.removeItem(SAFE_BROWSING_INDICATOR_STORAGE_KEY)
            setModeState("sfw")
            setIndicatorState("toggle")
            setIsAuthenticated(false)
            setIsLoading(false)
            return
          }
          
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`)
          }
          
          const user = await res.json()
          
          // Check if this is a degraded/fallback response
          if (user._synced === false && retryCount < maxRetries) {
            console.warn(`[SafeBrowsing] Fallback response (attempt ${retryCount + 1}/${maxRetries + 1}):`, user._warning)
            retryCount++
            await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, retryCount - 1)))
            continue // Retry
          }
          
          // Use the value (either synced or final fallback after retries)
          if (isMounted) {
            const newMode = user.safe_browsing_mode || cachedMode || "sfw"
            const newIndicator = user.safe_browsing_indicator || cachedIndicator || "toggle"
            
            setModeState(newMode)
            setIndicatorState(newIndicator)
            setIsAuthenticated(true)
            
            // Cache only synced values
            if (user._synced !== false) {
              localStorage.setItem(SAFE_BROWSING_STORAGE_KEY, newMode)
              localStorage.setItem(SAFE_BROWSING_INDICATOR_STORAGE_KEY, newIndicator)
            }
          }
          return // Success
          
        } catch (err: unknown) {
          retryCount++
          if (retryCount <= maxRetries) {
            await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, retryCount - 1)))
          }
        }
      }
      
      // All retries failed - use cached values if we haven't already
      if (isMounted && !cachedMode) {
        setModeState("sfw")
        setIndicatorState("toggle")
        setIsAuthenticated(false)
        setIsLoading(false)
      }
    }
    
    loadSettings()
    
    return () => {
      isMounted = false
    }
  }, [])

  const executeSetMode = useCallback(async (newMode: SafeBrowsingMode) => {
    if (!isAuthenticated) {
      return
    }
    setModeState(newMode)
    localStorage.setItem(SAFE_BROWSING_STORAGE_KEY, newMode)

    try {
      await fetch("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ safe_browsing_mode: newMode }),
      })
    } catch {
      console.error("Failed to save safe browsing mode to server")
    }
  }, [isAuthenticated])

  const setMode = useCallback(async (newMode: SafeBrowsingMode) => {
    if (newMode === "nsfw" && mode !== "nsfw") {
      // FIX: Store in ref so the modal callback always reads the latest value
      pendingModeRef.current = newMode
      setIsAgeModalOpen(true)
      return
    }
    await executeSetMode(newMode)
  }, [mode, executeSetMode])

  // FIX: Read from ref instead of state to avoid stale closure
  const handleAgeConfirm = useCallback(async () => {
    const pendingMode = pendingModeRef.current
    if (pendingMode) {
      await executeSetMode(pendingMode)
    }
    setIsAgeModalOpen(false)
    pendingModeRef.current = null
  }, [executeSetMode])

  const handleAgeCancel = useCallback(() => {
    setIsAgeModalOpen(false)
    pendingModeRef.current = null
  }, [])

  const setIndicator = useCallback(async (newIndicator: SafeBrowsingIndicator) => {
    if (!isAuthenticated) {
      return
    }
    setIndicatorState(newIndicator)
    localStorage.setItem(SAFE_BROWSING_INDICATOR_STORAGE_KEY, newIndicator)

    try {
      await fetch("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ safe_browsing_indicator: newIndicator }),
      })
    } catch {
      console.error("Failed to save safe browsing indicator to server")
    }
  }, [isAuthenticated])

  const cycleMode = useCallback(() => {
    const modes: SafeBrowsingMode[] = ["sfw", "sfw_plus", "nsfw"]
    const currentIndex = modes.indexOf(mode)
    const nextIndex = (currentIndex + 1) % modes.length
    setMode(modes[nextIndex])
  }, [mode, setMode])

  return (
    <SafeBrowsingContext.Provider
      value={{
        mode,
        indicator,
        isLoading,
        isAuthenticated,
        setMode,
        setIndicator,
        cycleMode,
      }}
    >
      {children}
      <AgeVerificationModal
        isOpen={isAgeModalOpen}
        onConfirm={handleAgeConfirm}
        onCancel={handleAgeCancel}
      />
    </SafeBrowsingContext.Provider>
  )
}

export function useSafeBrowsing(): SafeBrowsingContextValue {
  const context = useContext(SafeBrowsingContext)
  
  if (!context) {
    return {
      mode: "sfw",
      indicator: "toggle",
      isLoading: true,
      isAuthenticated: false,
      setMode: async () => {},
      setIndicator: async () => {},
      cycleMode: () => {},
    }
  }
  
  return context
}
