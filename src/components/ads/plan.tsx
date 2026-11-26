'use client'

import * as React from 'react'
import { Ban, Check, ChevronLeft, ChevronRight, Layers, Link2, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Button, Card, CardHeader, EmptyState, ScoreRing } from '@/components/ui/primitives'
import { Disclosure } from '@/components/ui/client'
import { MATCH_TYPE_HELP } from '@/lib/ads/objectives'
import { RSA, adStrength, glyphLength } from '@/lib/ads/validate'
import type { AdCampaignStructure, AdCreative, AdGroupPlan, AdKeyword } from '@/lib/db/schema'

/**
 * The plan, laid out to be read rather than admired.
 *
 * The person approving this has said they are not from marketing, so every
 * Google concept on screen is either shown as a consequence they can judge
 * ("this search will trigger the ad") or explained in one sentence beside it.
 * Nothing is left as a term they are expected to already know.
 */
export function PlanView({
  structure,
  finalUrl,
}: {
  structure: AdCampaignStructure | null
  finalUrl: string | null
}) {
  if (!structure || structure.adGroups.length === 0) {
    return (
      <Card>
        <EmptyState
          title="There is no plan yet"
          description="Nothing has been written for this campaign. Build it first, and the ads, searches and exclusions will appear here for checking."
        />
      </Card>
    )
  }

  const negatives = structure.negativeKeywords ?? []
  const sitelinks = structure.sitelinks ?? []
  const callouts = structure.callouts ?? []

  return (
    <div className="space-y-4">
      {structure.adGroups.map((group, i) => (
        <AdGroupCard key={`${group.name}-${i}`} group={group} finalUrl={finalUrl} />
      ))}

      {negatives.length > 0 && (
        <Card>
          <CardHeader
            title="Searches the ads will stay out of"
            description="These stop the ads showing for searches you do not want, which is the cheapest money this campaign will save."
            icon={<Ban className="h-4 w-4" />}
            actions={<Badge tone="neutral">{negatives.length}</Badge>}
          />
          <ul className="divide-y divide-line">
            {negatives.map((n, i) => (
              <li key={`${n.text}-${i}`} className="flex items-start gap-3 px-5 py-3">
                <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-fg" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-[13.5px] font-medium text-ink">{n.text}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-ink-muted">{n.reason}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(sitelinks.length > 0 || callouts.length > 0) && (
        <Card>
          <CardHeader
            title="Extra links and phrases under the ad"
            description="Google can show these beneath the ad at no extra cost. They take up more of the results page and give people more ways in."
            icon={<Link2 className="h-4 w-4" />}
          />
          <div className="space-y-5 p-5">
            {sitelinks.length > 0 && (
              <div>
                <p className="label mb-2">Links ({sitelinks.length})</p>
                <ul className="space-y-2.5">
                  {sitelinks.map((link, i) => (
                    <li key={i} className="min-w-0 rounded-lg bg-bg-subtle px-3.5 py-2.5">
                      <p className="break-words text-[13.5px] font-medium text-brand-600">
                        {link.text}
                      </p>
                      {(link.description1 || link.description2) && (
                        <p className="mt-0.5 break-words text-[13px] leading-relaxed text-ink-muted">
                          {[link.description1, link.description2].filter(Boolean).join(' ')}
                        </p>
                      )}
                      <p className="mt-1 break-all text-2xs text-ink-faint">{link.finalUrl}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {callouts.length > 0 && (
              <div>
                <p className="label mb-2">Short phrases ({callouts.length})</p>
                <div className="flex flex-wrap gap-1.5">
                  {callouts.map((c, i) => (
                    <span
                      key={i}
                      className="max-w-full break-words rounded-md bg-bg-inset px-2 py-1 text-xs text-ink-muted"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- ad group */

function AdGroupCard({ group, finalUrl }: { group: AdGroupPlan; finalUrl: string | null }) {
  return (
    <Card>
      <CardHeader
        title={group.name}
        description={group.theme}
        icon={<Layers className="h-4 w-4" />}
        actions={
          <Badge tone="neutral">
            {group.keywords.length} search{group.keywords.length === 1 ? '' : 'es'}
          </Badge>
        }
      />
      <div className="space-y-6 p-5">
        <p className="rounded-lg bg-bg-subtle px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-muted">
          This is one set of ads written around a single theme. Grouping them this way is what lets
          the ad echo the words someone actually typed, and a close match costs less per click than a
          loose one.
        </p>

        <Keywords keywords={group.keywords} />

        {group.ads.map((ad, i) => (
          <Advert
            key={i}
            ad={ad}
            keywords={group.keywords}
            finalUrl={finalUrl}
            index={i}
            total={group.ads.length}
          />
        ))}
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------- keywords */

const MATCH_TYPE_LABEL: Record<string, string> = {
  EXACT: 'That search and little else',
  PHRASE: 'Searches containing the phrase',
  BROAD: 'Anything Google judges related',
}

/** How the same term is written in the Google Ads screens, so it is recognisable there. */
const MATCH_TYPE_NOTATION: Record<string, string> = {
  EXACT: 'written [in brackets] in Google',
  PHRASE: 'written "in quotes" in Google',
  BROAD: 'written plainly in Google',
}

const MATCH_ORDER = ['EXACT', 'PHRASE', 'BROAD']

function Keywords({ keywords }: { keywords: AdKeyword[] }) {
  const byType = MATCH_ORDER.map((type) => ({
    type,
    list: keywords.filter((k) => k.matchType === type),
  })).filter((g) => g.list.length > 0)

  const explained = keywords.filter((k) => k.rationale?.trim())

  if (keywords.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-ink-muted">
        No searches are attached to this set of ads, so it would never show.
      </p>
    )
  }

  return (
    <section>
      <h3 className="text-[13.5px] font-semibold text-ink">What someone has to search for</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
        An ad can only appear if someone types something close to one of these. How close depends on
        the setting each one is under.
      </p>

      <div className="mt-4 space-y-4">
        {byType.map(({ type, list }) => (
          <div key={type}>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h4 className="text-[13px] font-semibold text-ink">
                {MATCH_TYPE_LABEL[type] ?? type}
              </h4>
              <span className="text-2xs text-ink-faint">
                {list.length} · {MATCH_TYPE_NOTATION[type] ?? ''}
              </span>
            </div>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink-muted">
              {MATCH_TYPE_HELP[type] ?? ''}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {list.map((kw, i) => (
                <span
                  key={`${kw.text}-${i}`}
                  title={kw.rationale ?? undefined}
                  className={cn(
                    'max-w-full break-words rounded-md border border-line bg-bg-subtle px-2 py-1 text-xs text-ink',
                    kw.rationale && 'cursor-help border-dashed',
                  )}
                >
                  {kw.text}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {explained.length > 0 && (
        <Disclosure className="mt-3.5" summary={`Why these ${explained.length} terms were chosen`}>
          <ul className="space-y-2">
            {explained.map((kw, i) => (
              <li key={`${kw.text}-${i}`} className="min-w-0 rounded-lg bg-bg-subtle px-3 py-2">
                <p className="break-words text-[13px] font-medium text-ink">{kw.text}</p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-ink-muted">{kw.rationale}</p>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </section>
  )
}

/* ----------------------------------------------------------------- ads */

const BAND_LABEL: Record<string, string> = {
  poor: 'Poor',
  average: 'Average',
  good: 'Good',
  excellent: 'Excellent',
}

function Advert({
  ad,
  keywords,
  finalUrl,
  index,
  total,
}: {
  ad: AdCreative
  keywords: AdKeyword[]
  finalUrl: string | null
  index: number
  total: number
}) {
  const combos = React.useMemo(() => combinations(ad), [ad])
  const [step, setStep] = React.useState(0)
  const strength = React.useMemo(() => adStrength(ad, keywords), [ad, keywords])

  const combo = combos[step] ?? { headlines: [], descriptions: [] }
  const display = displayUrl(finalUrl, ad.path1, ad.path2)

  return (
    <section>
      <h3 className="text-[13.5px] font-semibold text-ink">
        {total > 1 ? `Advert ${index + 1} of ${total}` : 'The advert'}
      </h3>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
        Google assembles the ad at the moment of the search, choosing from the headlines and
        descriptions below. Nobody sees a fixed ad — they see one of the combinations. Here is one of
        them.
      </p>

      {/* Deliberately close to how a paid result actually looks, because the
          question this answers is "would I click that", not "is the copy good". */}
      <div className="mt-3 rounded-xl border border-line bg-bg-subtle p-4">
        <p className="text-2xs font-bold text-ink">Sponsored</p>
        <p className="mt-1.5 truncate text-[13px] text-ink-muted" title={display}>
          {display}
        </p>
        <p className="mt-0.5 break-words text-[17px] font-medium leading-snug text-brand-600">
          {combo.headlines.join(' | ') || 'No headline written'}
        </p>
        <p className="mt-1 break-words text-[13px] leading-relaxed text-ink-muted">
          {combo.descriptions.join(' ') || 'No description written'}
        </p>
      </div>

      {combos.length > 1 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="secondary"
            onClick={() => setStep((s) => (s - 1 + combos.length) % combos.length)}
          >
            <ChevronLeft className="h-3 w-3" />
            Previous
          </Button>
          <Button
            size="xs"
            variant="secondary"
            onClick={() => setStep((s) => (s + 1) % combos.length)}
          >
            Another combination
            <ChevronRight className="h-3 w-3" />
          </Button>
          <span className="tnum text-xs text-ink-faint">
            {step + 1} of {combos.length} shown
          </span>
        </div>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <AssetList
          title="Headlines"
          note={`Up to ${RSA.headlineChars} characters each.`}
          items={ad.headlines}
          limit={RSA.headlineChars}
        />
        <AssetList
          title="Descriptions"
          note={`Up to ${RSA.descriptionChars} characters each.`}
          items={ad.descriptions}
          limit={RSA.descriptionChars}
        />
      </div>

      <div className="mt-4 rounded-xl border border-line p-4">
        <div className="flex items-start gap-3.5">
          <ScoreRing score={strength.score} size={46} label={`${strength.score} out of 100`} />
          <div className="min-w-0">
            <p className="text-[13.5px] font-semibold text-ink">
              Estimated ad strength: {BAND_LABEL[strength.band] ?? strength.band}
            </p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink-muted">
              Four things move this number, and all four are about giving Google more to work with.
            </p>
          </div>
        </div>

        <ul className="mt-3.5 space-y-2.5">
          {strength.drivers.map((d, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span
                className={cn(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
                  d.ok ? 'bg-ok-bg text-ok-fg' : 'bg-warn-bg text-warn-fg',
                )}
                aria-hidden
              >
                {d.ok ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink">{d.label}</p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-ink-muted">{d.detail}</p>
              </div>
            </li>
          ))}
        </ul>

        <p className="mt-3.5 border-t border-line pt-2.5 text-2xs leading-relaxed text-ink-faint">
          This is our own estimate of Google&rsquo;s Ad Strength, worked out on this page from the
          inputs Google publishes. Google&rsquo;s own score does not exist until the ad has been
          uploaded, and it may differ from this one.
        </p>
      </div>
    </section>
  )
}

function AssetList({
  title,
  note,
  items,
  limit,
}: {
  title: string
  note: string
  items: string[]
  limit: number
}) {
  return (
    <div className="min-w-0">
      <p className="label">
        {title} ({items.length})
      </p>
      <p className="mt-0.5 text-2xs text-ink-faint">{note}</p>
      <ul className="mt-2 space-y-1.5">
        {items.map((text, i) => {
          const length = glyphLength(text)
          const over = length > limit
          // Anything within three characters of the ceiling is worth flagging:
          // it survives today and breaks the moment someone tweaks a word.
          const tight = !over && length >= limit - 3
          return (
            <li key={i} className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 break-words text-[13px] text-ink">{text}</span>
              <span
                className={cn(
                  'tnum shrink-0 text-2xs font-semibold',
                  over ? 'text-danger-fg' : tight ? 'text-warn-fg' : 'text-ink-faint',
                )}
                title={over ? `Over Google's limit by ${length - limit}` : undefined}
              >
                {length}/{limit}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* --------------------------------------------------------------- helpers */

/**
 * A handful of the combinations Google could assemble, generated deterministically
 * so stepping back and forth shows the same ads rather than reshuffling under
 * the reader. Offsetting by two keeps consecutive combinations visibly
 * different, which is the point of showing more than one.
 */
function combinations(ad: AdCreative): { headlines: string[]; descriptions: string[] }[] {
  const headlines = ad.headlines.filter(Boolean)
  const descriptions = ad.descriptions.filter(Boolean)
  if (headlines.length === 0) return []

  const count = Math.min(6, headlines.length)
  const out: { headlines: string[]; descriptions: string[] }[] = []

  for (let i = 0; i < count; i++) {
    const picked = [0, 1, 2]
      .map((k) => headlines[(i + k * 2) % headlines.length])
      .filter(Boolean)
    const shown = descriptions.length
      ? [descriptions[i % descriptions.length], descriptions[(i + 1) % descriptions.length]]
      : []
    out.push({
      headlines: Array.from(new Set(picked)),
      descriptions: Array.from(new Set(shown.filter(Boolean))),
    })
  }
  return out
}

/** The address as Google prints it above the headline, not the address clicked. */
function displayUrl(finalUrl: string | null, path1?: string, path2?: string): string {
  let host = finalUrl ?? 'your-website.com'
  try {
    host = new URL(finalUrl ?? '').hostname.replace(/^www\./, '')
  } catch {
    host = (finalUrl ?? 'your-website.com').replace(/^https?:\/\//, '').split('/')[0]
  }
  const segments = [path1, path2]
    .filter((p): p is string => Boolean(p?.trim()))
    .map((p) => p.trim().replace(/\s+/g, '-'))
  return segments.length > 0 ? `${host}/${segments.join('/')}` : host
}
