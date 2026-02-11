import { Shell } from "@/components/layout/shell"
import { getCachedUser } from "@/lib/supabase/cached-user"
import { redirect } from "next/navigation"
import { cookies } from "next/headers"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await getCachedUser()

  if (!user) {
    // Graceful degradation: if auth cookie exists but getCachedUser timed out,
    // render the shell instead of redirecting to login (avoids kicking out
    // authenticated users when Supabase is slow).
    let hasAuthCookie = false
    try {
      const cookieStore = await cookies()
      hasAuthCookie = cookieStore.getAll().some(
        c => c.name.startsWith('sb-') && c.name.includes('-auth-token')
      )
    } catch {
      // cookies() failed - treat as no cookie
    }

    if (!hasAuthCookie) {
      redirect("/login")
    }
  }

  return <Shell>{children}</Shell>
}
