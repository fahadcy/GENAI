import type { Metadata } from 'next'
import { AlertTriangle, Palette, ShieldCheck, Sparkles } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { PageBody, SectionHeading } from '@/components/shell/page'
import { Badge, Card, EmptyState, StatTile } from '@/components/ui/primitives'
import { formatPercent } from '@/components/domain'
import { BrandEditor } from '@/components/settings/brand-editor'
import { LegalRulesCard } from '@/components/settings/legal-rules'
import { brandGovernance, brandImpact } from '../queries'

export const metadata: Metadata = { title: 'Brand & legal' }

export default async function BrandSettingsPage() {
  const auth = await requireAuth()
  const [{ profiles, rules }, impact] = await Promise.all([
    brandGovernance(auth.workspace.id),
    brandImpact(auth.workspace.id),
  ])

  const canEdit = can(auth.role, 'brand:manage')
  const profile = profiles.find((p) => p.isDefault) ?? profiles[0]

  if (!profile) {
    return (
      <PageBody className="max-w-[1440px]">
        <Card>
          <EmptyState
            icon={<Palette className="h-5 w-5" />}
            title="No brand profile on this workspace"
            description="Generation needs a default brand profile to score against. One is normally created with the workspace; if it has been removed, an owner will need to restore it before any content can be produced."
          />
        </Card>
      </PageBody>
    )
  }

  const hits: Record<string, number> = {}
  for (const f of impact.findings) hits[f.rule] = f.hits

  const passRate = impact.scored > 0 ? impact.passed / impact.scored : null
  const activeRules = rules.filter((r) => r.active).length

  return (
    <PageBody className="max-w-[1440px]">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="First-pass rate"
          value={passRate === null ? '—' : formatPercent(passRate, 0)}
          delta={
            passRate !== null
              ? {
                  value: passRate >= 0.95 ? 'at target' : `${Math.round((0.95 - passRate) * 100)}pt`,
                  direction: passRate >= 0.95 ? 'flat' : 'down',
                  good: passRate >= 0.95,
                }
              : undefined
          }
          hint={`${impact.passed}/${impact.scored} vs 95% target`}
          icon={<ShieldCheck className="h-4 w-4" />}
        />
        <StatTile
          label="Average composite"
          value={impact.avgComposite === null ? '—' : Math.round(impact.avgComposite)}
          hint={
            impact.avgBrand !== null && impact.avgCompliance !== null
              ? `brand ${Math.round(impact.avgBrand)} · compliance ${Math.round(impact.avgCompliance)}`
              : 'nothing scored yet'
          }
          icon={<Sparkles className="h-4 w-4" />}
        />
        <StatTile
          label="Rules in force"
          value={activeRules + profile.bannedTerms.length + profile.requiredDisclaimers.length}
          hint={`${activeRules} legal · ${profile.bannedTerms.length} banned · ${profile.requiredDisclaimers.length} disclaimers`}
        />
        <StatTile
          label="Needed a human edit"
          value={impact.edited}
          hint={
            impact.scored > 0
              ? `${formatPercent(impact.edited / impact.scored, 0)} of generated work`
              : 'nothing generated yet'
          }
        />
      </div>

      {/* Which rules are doing the work. An over-broad pattern shows up here as
          a rule that catches far more than the rest — worth reading before
          anyone concludes the model is the problem. */}
      {impact.findings.length > 0 && (
        <Card className="mt-6 overflow-hidden">
          <div className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">What the guardrails actually caught</h2>
              <p className="mt-0.5 text-[13px] leading-snug text-ink-muted">
                Counted across every asset this workspace has scored. A rule with no hits is either
                well-observed or badly written.
              </p>
            </div>
            <ul className="flex flex-wrap gap-2 lg:justify-end">
              {impact.findings.map((f) => (
                <li
                  key={f.rule}
                  className="flex items-center gap-2 rounded-lg border border-line bg-bg-subtle px-2.5 py-1.5"
                >
                  <Badge tone={f.severity === 'high' ? 'danger' : f.severity === 'medium' ? 'warn' : 'neutral'}>
                    {f.severity}
                  </Badge>
                  <span className="text-xs text-ink">{f.rule}</span>
                  <span className="tnum text-xs font-semibold text-ink-muted">{f.hits}</span>
                </li>
              ))}
            </ul>
          </div>
          {passRate !== null && passRate < 0.95 && (
            <p className="flex items-start gap-1.5 border-t border-line bg-warn-bg/40 px-5 py-2.5 text-xs leading-relaxed text-warn-fg">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              First-pass rate is {formatPercent(passRate, 0)} against a 95% target. Either the tone
              targets are further from the model's natural output than they need to be, or one of the
              patterns above is catching legitimate copy. Test both in the panel on the right.
            </p>
          )}
        </Card>
      )}

      <div className="mt-6">
        <BrandEditor profile={profile} legalRules={rules} canEdit={canEdit} />
      </div>

      <div className="mt-8">
        <SectionHeading
          title="Legal rules"
          description="Pattern-based checks maintained separately from the voice, because they are usually owned by a different person."
        />
        <LegalRulesCard rules={rules} hits={hits} canEdit={canEdit} />
      </div>

      {profiles.length > 1 && (
        <p className="mt-4 text-2xs text-ink-faint">
          This workspace has {profiles.length} brand profiles. Generation uses{' '}
          <span className="font-medium text-ink-muted">{profile.name}</span> because it is marked as the
          default; the others are available to briefs that name them.
        </p>
      )}
    </PageBody>
  )
}
