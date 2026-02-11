"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Plus, Check, Loader2, Globe, MoreHorizontal, Wrench, Share2, Link2, RefreshCw } from "lucide-react"
import { addToLibrary } from "@/lib/actions/library-actions"
import { updateSeriesSourcePreference } from "@/lib/actions/series-actions"
import { SyncOutbox } from "@/lib/sync/outbox"
import { toast } from "sonner"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AddReadingSourceDialog } from "./source-management/AddReadingSourceDialog"
import { FixMetadataDialog } from "./source-management/FixMetadataDialog"

export function SeriesActions({ 
  seriesId, 
  seriesTitle = "this series",
  libraryEntry,
  sources = [],
  seriesPreference = null
}: { 
  seriesId: string, 
  seriesTitle?: string,
  libraryEntry: any,
  sources?: any[],
  seriesPreference?: string | null
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [updatingSource, setUpdatingSource] = useState(false)
  const [showAddSource, setShowAddSource] = useState(false)
  const [showFixMetadata, setShowFixMetadata] = useState(false)
  const [showSubmitLinkInfo, setShowSubmitLinkInfo] = useState(false)
  const [isInLibrary, setIsInLibrary] = useState(!!libraryEntry?.id)

  const handleAdd = async () => {
    setLoading(true)
    try {
      if (!navigator.onLine) {
        SyncOutbox.enqueue('LIBRARY_ADD', { seriesId: seriesId, status: 'reading' });
        toast.success("Series queued to be added (Offline)");
        setIsInLibrary(true)
        return;
      }
      const result = await addToLibrary(seriesId)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success("Added to library")
        setIsInLibrary(true)
        router.refresh()
      }
    } catch (error: unknown) {
      SyncOutbox.enqueue('LIBRARY_ADD', { seriesId: seriesId, status: 'reading' });
      toast.info("Connection lost. Series will be added when online.");
      setIsInLibrary(true)
    } finally {
      setLoading(false)
    }
  }

  const handleRemove = async () => {
    if (!libraryEntry?.id) {
      toast.error("Cannot remove: Library entry not found")
      setIsInLibrary(false)
      return
    }

    setLoading(true)
    try {
      const response = await fetch(`/api/library/${libraryEntry.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.message || 'Failed to remove from library')
      }

      toast.success("Removed from library")
      setIsInLibrary(false)
      router.refresh()
    } catch (error: unknown) {
        toast.error(error instanceof Error ? error.message : "Failed to remove from library")
    } finally {
      setLoading(false)
    }
  }

  const handleSourceChange = async (sourceName: string) => {
    setUpdatingSource(true)
    try {
      const result = await updateSeriesSourcePreference(seriesId, sourceName === "none" ? null : sourceName)
      
      if (result.success) {
        toast.success(`Preference updated to ${sourceName === "none" ? "Global Default" : sourceName}`)
      }
    } catch (error: unknown) {
      toast.error("Failed to update preferred source")
    } finally {
      setUpdatingSource(false)
    }
  }

  const handleShare = () => {
    const url = window.location.href
    if (navigator.share) {
      navigator.share({
        title: seriesTitle,
        url: url
      }).catch(console.error)
    } else {
      navigator.clipboard.writeText(url)
      toast.success("Link copied to clipboard")
    }
  }

  const scrollToChapters = () => {
    setShowSubmitLinkInfo(false)
    const element = document.getElementById('chapter-list')
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' })
      // Highlight the chapter list briefly
      element.classList.add('ring-2', 'ring-amber-500', 'ring-offset-2')
      setTimeout(() => {
        element.classList.remove('ring-2', 'ring-amber-500', 'ring-offset-2')
      }, 2000)
    }
  }

  const preferredSource = seriesPreference || libraryEntry?.preferred_source || "none"

  return (
    <div className="flex items-center gap-2">
      {isInLibrary ? (
        <Button 
          variant="outline" 
          className="rounded-full px-6 border-zinc-200 dark:border-zinc-800"
          onClick={handleRemove}
          disabled={loading}
        >
          {loading ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Check className="size-4 mr-2 text-green-500" />}
          In Library
        </Button>
      ) : (
        <Button 
          className="bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 rounded-full px-8"
          onClick={handleAdd}
          disabled={loading}
        >
          {loading ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Plus className="size-4 mr-2" />}
          Add to Library
        </Button>
      )}

      {sources.length > 0 && (
        <div className="flex items-center">
          <Select 
            value={preferredSource} 
            onValueChange={handleSourceChange}
            disabled={updatingSource}
          >
            <SelectTrigger className="w-[160px] h-10 rounded-full border-zinc-200 dark:border-zinc-800 bg-transparent px-4">
              <Globe className="size-3.5 mr-2 text-zinc-500" />
              <SelectValue placeholder="Preferred Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Use Global Default</SelectItem>
              {sources.map(source => (
                <SelectItem key={source.id} value={source.source_name}>
                  {source.source_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Submit Link Button - Visible */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button 
            variant="outline" 
            size="icon" 
            className="rounded-full border-zinc-200 dark:border-zinc-800"
            onClick={() => setShowSubmitLinkInfo(true)}
          >
            <Link2 className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Submit a reading link</TooltipContent>
      </Tooltip>

      {/* Share Button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button 
            variant="outline" 
            size="icon" 
            className="rounded-full border-zinc-200 dark:border-zinc-800"
            onClick={handleShare}
          >
            <Share2 className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Share series</TooltipContent>
      </Tooltip>

      {/* More Options Menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" className="rounded-full border-zinc-200 dark:border-zinc-800">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {/* Submit Reading Link */}
          <DropdownMenuItem onSelect={() => setShowSubmitLinkInfo(true)} className="flex-col items-start py-2">
            <div className="flex items-center w-full">
              <Link2 className="size-4 mr-2 shrink-0" />
              <span className="font-medium">Submit Reading Link</span>
            </div>
            <span className="text-[11px] text-zinc-500 ml-6">Add link for a specific chapter</span>
          </DropdownMenuItem>
          
          <DropdownMenuSeparator />
          
          {/* Sync from MangaDex */}
          <DropdownMenuItem onSelect={() => setShowAddSource(true)} className="flex-col items-start py-2">
            <div className="flex items-center w-full">
              <RefreshCw className="size-4 mr-2 shrink-0" />
              <span className="font-medium">Sync from MangaDex</span>
            </div>
            <span className="text-[11px] text-zinc-500 ml-6">Auto-import all chapters</span>
          </DropdownMenuItem>
          
          <DropdownMenuSeparator />
          
          {/* Fix Metadata */}
          <DropdownMenuItem onSelect={() => setShowFixMetadata(true)} className="flex-col items-start py-2">
            <div className="flex items-center w-full">
              <Wrench className="size-4 mr-2 shrink-0" />
              <span className="font-medium">Fix metadata</span>
            </div>
            <span className="text-[11px] text-zinc-500 ml-6">Report incorrect title, cover, or info</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Submit Link Info Dialog */}
      <Dialog open={showSubmitLinkInfo} onOpenChange={setShowSubmitLinkInfo}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="size-5" />
              Submit Reading Links
            </DialogTitle>
            <DialogDescription>
              Help others find where to read this series
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="bg-zinc-50 dark:bg-zinc-900 p-4 rounded-lg space-y-3">
              <h4 className="font-medium text-sm">How it works:</h4>
              <ol className="text-sm text-zinc-600 dark:text-zinc-400 space-y-2.5">
                <li className="flex items-start gap-2">
                  <span className="font-bold text-zinc-900 dark:text-zinc-100">1.</span>
                  <span>Find the chapter you want to add a link for in the list below</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-bold text-zinc-900 dark:text-zinc-100">2.</span>
                  <span className="flex items-center gap-1.5">
                    Click the <Link2 className="inline size-3.5 text-amber-600" /> or <Plus className="inline size-3.5 text-amber-600" /> button next to the chapter
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-bold text-zinc-900 dark:text-zinc-100">3.</span>
                  <span>Paste the URL where you read the chapter (any site works!)</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-bold text-zinc-900 dark:text-zinc-100">4.</span>
                  <span>Others can now find and use your link</span>
                </li>
              </ol>
            </div>
            
            <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3 rounded-lg">
              <p className="text-xs text-blue-700 dark:text-blue-300">
                <strong>Tip:</strong> This is for sharing where YOU read a chapter. 
                It&apos;s different from &quot;Sync from MangaDex&quot; which automatically imports chapter metadata.
              </p>
            </div>
          </div>
          
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowSubmitLinkInfo(false)}>
              Close
            </Button>
            <Button onClick={scrollToChapters}>
              Go to Chapters
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddReadingSourceDialog 
        seriesId={seriesId}
        seriesTitle={seriesTitle}
        open={showAddSource}
        onOpenChange={setShowAddSource}
      />
      <FixMetadataDialog
        seriesId={seriesId}
        seriesTitle={seriesTitle}
        open={showFixMetadata}
        onOpenChange={setShowFixMetadata}
      />
    </div>
  )
}
