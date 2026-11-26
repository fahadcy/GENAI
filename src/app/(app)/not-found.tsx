import { SearchX } from 'lucide-react'
import { LinkButton } from '@/components/ui/primitives'

/**
 * Six pages call `notFound()` — a campaign, an approval, a profile, a segment,
 * an asset, an ad campaign. Each one was rendering Next's unstyled default
 * outside the app shell. Inside this route group the sidebar stays, so a dead
 * link is a wrong turn rather than a dead end.
 */
export default function AppNotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-16">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-5 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface-hover">
          <SearchX className="h-5 w-5 text-ink-faint" aria-hidden />
        </div>

        <h1 className="text-lg font-semibold text-ink">Not found</h1>

        <p className="mx-auto mt-2 max-w-sm text-[14px] leading-relaxed text-ink-muted">
          This does not exist, or it belongs to a different workspace. It may also have
          been deleted since the link was made.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <LinkButton href="/command-center" size="md" variant="primary">
            Back to the dashboard
          </LinkButton>
        </div>
      </div>
    </div>
  )
}
