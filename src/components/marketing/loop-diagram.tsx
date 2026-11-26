import { cn } from '@/lib/cn'

/**
 * The five-stage loop, drawn rather than described. This is the product's
 * central claim, so it gets a real diagram: five gated stages in sequence and
 * an explicit feedback arc from results back into generation.
 *
 * Two renderings of the same content — a wide inline SVG from `md` up, and a
 * vertical rail below it. Only one is in the tree at a time (display: none
 * removes the other from the accessibility tree too), so nothing is read twice.
 */

export type LoopStage = {
  n: number
  name: string
  lines: [string, string]
  /** The governance gate. Marked visually, because it is the point of the loop. */
  gate?: boolean
}

export const LOOP_STAGES: LoopStage[] = [
  { n: 1, name: 'Generate', lines: ['Brief in, on-brand', 'variants per channel.'] },
  { n: 2, name: 'Review', lines: ['Scored on voice and', 'legal before review.'] },
  { n: 3, name: 'Approve', lines: ['The right people sign', 'off. Decisions logged.'], gate: true },
  { n: 4, name: 'Publish', lines: ['One calendar, every', 'channel and send time.'] },
  { n: 5, name: 'Monitor', lines: ['Live results tied to', 'spend and decisions.'] },
]

const NODE_W = 180
const NODE_H = 104
const NODE_Y = 18
const CENTRES = [98, 319, 540, 761, 982]
const ARC_Y = 186

export function LoopDiagram({ className }: { className?: string }) {
  return (
    <div className={cn('w-full', className)}>
      {/* Wide rendering, framed so the diagram reads as an exhibit rather than
          as decoration floating in the section. */}
      <div className="hidden rounded-panel border border-line bg-surface p-6 shadow-card md:block lg:p-9">
        <svg
          viewBox="0 0 1080 214"
          className="h-auto w-full"
          role="img"
          aria-labelledby="loop-title loop-desc"
        >
          <title id="loop-title">The Aurea pipeline</title>
          <desc id="loop-desc">
            Five stages in sequence — generate, review, approve, publish, monitor — with a feedback
            arc returning from monitor to generate, so measured results become the next brief.
          </desc>

          <defs>
            <marker
              id="loop-arrow"
              viewBox="0 0 10 10"
              refX="8.5"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0.5 L9 5 L0 9.5 Z" fill="rgb(var(--ink-faint))" />
            </marker>
          </defs>

          {/* Forward arrows sit under the nodes so the caps never overlap a border. */}
          {CENTRES.slice(0, -1).map((cx, i) => (
            <line
              key={cx}
              x1={cx + NODE_W / 2 + 7}
              y1={NODE_Y + NODE_H / 2}
              x2={CENTRES[i + 1] - NODE_W / 2 - 7}
              y2={NODE_Y + NODE_H / 2}
              stroke="rgb(var(--ink-faint))"
              strokeWidth="1.5"
              markerEnd="url(#loop-arrow)"
            />
          ))}

          {/* Feedback arc: monitor → generate. */}
          <path
            d={`M ${CENTRES[4]} ${NODE_Y + NODE_H} V ${ARC_Y - 18} Q ${CENTRES[4]} ${ARC_Y} ${CENTRES[4] - 18} ${ARC_Y} H ${CENTRES[0] + 18} Q ${CENTRES[0]} ${ARC_Y} ${CENTRES[0]} ${ARC_Y - 18} V ${NODE_Y + NODE_H + 10}`}
            fill="none"
            stroke="rgb(var(--brand-500))"
            strokeWidth="1.75"
            strokeDasharray="5 5"
            markerEnd="url(#loop-arrow)"
          />

          {/* Chip breaking the arc, naming what the feedback actually is. */}
          <g>
            <rect
              x="340"
              y={ARC_Y - 16}
              width="400"
              height="32"
              rx="16"
              className="fill-brand-50 stroke-brand-200"
              strokeWidth="1"
            />
            <text
              x="540"
              y={ARC_Y + 4.5}
              textAnchor="middle"
              className="fill-brand-700 text-[13px] font-semibold"
            >
              Optimise — results become the next brief
            </text>
          </g>

          {CENTRES.map((cx, i) => {
            const s = LOOP_STAGES[i]
            const x0 = cx - NODE_W / 2
            return (
              <g key={s.name}>
                <rect
                  x={x0}
                  y={NODE_Y}
                  width={NODE_W}
                  height={NODE_H}
                  rx="14"
                  className={cn('fill-bg-subtle', s.gate ? 'stroke-gold-400' : 'stroke-line-strong')}
                  strokeWidth={s.gate ? 1.75 : 1}
                />
                <circle
                  cx={x0 + 24}
                  cy={NODE_Y + 26}
                  r="11"
                  className={s.gate ? 'fill-gold-100' : 'fill-brand-100'}
                />
                <text
                  x={x0 + 24}
                  y={NODE_Y + 30}
                  textAnchor="middle"
                  className={cn('text-[11px] font-semibold', s.gate ? 'fill-gold-600' : 'fill-brand-700')}
                >
                  {s.n}
                </text>
                <text x={x0 + 43} y={NODE_Y + 31} className="fill-ink text-[16.5px] font-semibold">
                  {s.name}
                </text>
                {s.gate && (
                  <text
                    x={x0 + NODE_W - 16}
                    y={NODE_Y + 30}
                    textAnchor="end"
                    className="fill-gold-600 text-[9.5px] font-semibold uppercase tracking-[0.12em]"
                  >
                    Gate
                  </text>
                )}
                <text x={x0 + 20} y={NODE_Y + 62} className="fill-ink-muted text-[12px]">
                  {s.lines[0]}
                </text>
                <text x={x0 + 20} y={NODE_Y + 80} className="fill-ink-muted text-[12px]">
                  {s.lines[1]}
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      {/* Narrow rendering */}
      <ol className="relative md:hidden">
        <span className="absolute bottom-6 left-[19px] top-6 w-px bg-line" aria-hidden />
        {LOOP_STAGES.map((s) => (
          <li key={s.name} className="relative flex gap-4 pb-5 last:pb-0">
            <span
              className={cn(
                'relative z-10 mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ring-1',
                s.gate
                  ? 'bg-gold-100 text-gold-600 ring-gold-400'
                  : 'bg-brand-50 text-brand-700 ring-brand-200',
              )}
            >
              {s.n}
            </span>
            <div className="min-w-0 flex-1 rounded-card border border-line bg-surface px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[15px] font-semibold text-ink">{s.name}</h3>
                {s.gate && (
                  <span className="text-2xs font-semibold uppercase tracking-wider text-gold-600">
                    Gate
                  </span>
                )}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                {s.lines[0]} {s.lines[1]}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <div className="ml-14 mt-1 rounded-card border border-dashed border-brand-200 bg-brand-50 px-4 py-3 md:hidden">
        <p className="text-[13px] font-semibold text-brand-700">
          Optimise — results become the next brief
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
          Monitoring feeds straight back into generation: fatiguing creative is flagged, a
          replacement is drafted, and the send window is re-proposed.
        </p>
      </div>
    </div>
  )
}
