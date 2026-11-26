/**
 * Shown while a page's data loads.
 *
 * Every screen here is dynamic and fires six to nine database queries at once,
 * so navigation could sit for a second or more with nothing happening — which
 * reads as a frozen app rather than a loading one. This is a skeleton rather
 * than a spinner because the shape arrives before the data does, and matching
 * the real layout stops the page jumping when it lands.
 */
export default function AppLoading() {
  return (
    <div className="animate-pulse px-4 py-6 sm:px-6 lg:px-8" aria-busy="true" aria-label="Loading">
      {/* Topbar stand-in */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="h-6 w-48 rounded-md bg-surface-hover" />
          <div className="mt-2 h-3.5 w-72 max-w-full rounded bg-surface-hover" />
        </div>
        <div className="h-8 w-28 shrink-0 rounded-lg bg-surface-hover" />
      </div>

      {/* Stat row */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl border border-line bg-surface" />
        ))}
      </div>

      {/* Main body */}
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 rounded-xl border border-line bg-surface" />
          ))}
        </div>
        <div className="h-64 w-full rounded-xl border border-line bg-surface lg:w-[320px] lg:shrink-0" />
      </div>

      <span className="sr-only">Loading</span>
    </div>
  )
}
