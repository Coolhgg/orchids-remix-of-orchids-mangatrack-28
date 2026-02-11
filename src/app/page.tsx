import { redirect } from 'next/navigation'
import { getCachedUser } from '@/lib/supabase/cached-user'
import { cookies } from 'next/headers'
import ScrollytellingLanding from '@/components/landing/ScrollytellingLanding'

export default async function Home() {
  const user = await getCachedUser()

  if (user) {
    const username = user.user_metadata?.username || user.app_metadata?.username
    if (!username) {
      redirect('/onboarding')
    }
    redirect('/library')
  }

  // Graceful degradation: if getCachedUser returned null but auth cookie exists,
  // the auth service may be slow. Redirect to library and let that page handle it
  // rather than showing the landing page to a logged-in user.
  try {
    const cookieStore = await cookies()
    const hasAuthCookie = cookieStore.getAll().some(
      c => c.name.startsWith('sb-') && c.name.includes('-auth-token')
    )
    if (hasAuthCookie) {
      redirect('/library')
    }
  } catch {
    // cookies() failed - proceed to landing page
  }

  return <ScrollytellingLanding />
}
