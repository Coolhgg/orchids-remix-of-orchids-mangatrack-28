"use client"

import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Clock, Users, AlertCircle } from "lucide-react"

interface ReleaseGroup {
  name: string
  id?: number
}

interface Release {
  id: string | number
  title: string
  chapter: string | null
  volume: string | null
  language: string | null
  published_at: string | null
  groups: ReleaseGroup[]
}

interface ReleaseInfoCardProps {
  seriesId: string
  className?: string
}

/**
 * Displays "Available On" metadata from MangaUpdates.
 * Shows scanlation group names without direct links (pirate site protection).
 */
export function ReleaseInfoCard({ seriesId, className }: ReleaseInfoCardProps) {
  const [releases, setReleases] = useState<Release[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchReleases() {
      try {
        setLoading(true)
        const res = await fetch(`/api/series/${seriesId}/releases?limit=5`)
        if (!res.ok) {
          throw new Error('Failed to fetch release info')
        }
        const data = await res.json()
        setReleases(data.releases || [])
      } catch (e: unknown) {
        console.error('[ReleaseInfoCard] Error:', e)
        setError('Failed to load release information')
      } finally {
        setLoading(false)
      }
    }

    fetchReleases()
  }, [seriesId])

  if (loading) {
    return (
      <div className={`bg-zinc-50 dark:bg-zinc-900/50 p-6 rounded-3xl border border-zinc-100 dark:border-zinc-800 space-y-4 ${className || ''}`}>
        <h3 className="font-bold flex items-center gap-2">
          <Users className="size-4" />
          Available On
        </h3>
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Clock className="size-3.5 animate-pulse" />
          Loading release info...
        </div>
      </div>
    )
  }

  if (error || releases.length === 0) {
    return null // Don't show the card if there's no data
  }

  // Group releases by group name for display
  const groupMap = new Map<string, { latestChapter: string | null; count: number; lastUpdated: string | null }>()
  
  for (const release of releases) {
    for (const group of release.groups) {
      const existing = groupMap.get(group.name)
      if (!existing) {
        groupMap.set(group.name, {
          latestChapter: release.chapter,
          count: 1,
          lastUpdated: release.published_at,
        })
      } else {
        existing.count++
        // Keep the higher chapter number
        if (release.chapter && existing.latestChapter) {
          const newCh = parseFloat(release.chapter)
          const existingCh = parseFloat(existing.latestChapter)
          if (!isNaN(newCh) && !isNaN(existingCh) && newCh > existingCh) {
            existing.latestChapter = release.chapter
            existing.lastUpdated = release.published_at
          }
        }
      }
    }
  }

  const groups = Array.from(groupMap.entries())

  return (
    <div className={`bg-amber-50 dark:bg-amber-900/10 p-6 rounded-3xl border border-amber-200 dark:border-amber-800/30 space-y-4 ${className || ''}`}>
      <div className="flex items-start justify-between">
        <h3 className="font-bold flex items-center gap-2 text-amber-900 dark:text-amber-200">
          <Users className="size-4" />
          Available On
        </h3>
        <Badge variant="outline" className="text-[10px] bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300">
          Unofficial
        </Badge>
      </div>
      
      <div className="space-y-3">
        {groups.map(([groupName, info]) => (
          <div 
            key={groupName}
            className="flex items-center justify-between p-3 rounded-xl bg-white dark:bg-zinc-950/50 border border-amber-200/50 dark:border-amber-800/20"
          >
            <div className="flex items-center gap-3">
              <div className="size-8 rounded-lg bg-amber-200 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 text-xs font-bold flex items-center justify-center">
                {groupName.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{groupName}</p>
                {info.latestChapter && (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Ch. {info.latestChapter}
                    {info.lastUpdated && (
                      <span className="ml-2 text-zinc-400">
                        · {formatRelativeTime(info.lastUpdated)}
                      </span>
                    )}
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-start gap-2 pt-2 text-[11px] text-amber-700 dark:text-amber-400">
        <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
        <p>
          These are unofficial scanlation sources. Links are not provided.
          Use the search feature on your preferred platform to find this series.
        </p>
      </div>
    </div>
  )
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`
  return `${Math.floor(diffDays / 365)}y ago`
}
