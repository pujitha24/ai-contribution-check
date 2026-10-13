import { describeSignal } from './rules.js'
import { code } from './text.js'
import type { Detection, Policy, RuleResult, RuleStatus } from './types.js'

export const COMMENT_MARKER = '<!-- ai-contribution-check:sticky -->'

const STATUS_LABEL: Record<RuleStatus, string> = {
  violation: 'Violation',
  unverified: 'Not verified',
  notice: 'Notice',
  pass: 'Pass',
  skipped: 'Skipped'
}

const STATUS_ORDER: RuleStatus[] = ['violation', 'unverified', 'notice', 'pass', 'skipped']

const HUMAN_ONLY_LABEL: Record<string, string> = {
  'review-replies': 'replies to review comments',
  'commit-messages': 'commit messages',
  'pr-description': 'the PR description',
  issues: 'issues'
}

export interface ReportInput {
  policyPath: string
  policy: Policy
  detection: Detection
  results: RuleResult[]
  violations: number
}

export function headline(input: Pick<ReportInput, 'detection' | 'results' | 'violations'>): string {
  const { detection, results, violations } = input
  if (violations > 0) {
    return `**${violations} policy violation${violations === 1 ? '' : 's'}** found.`
  }
  if (results.some((r) => r.status === 'unverified')) {
    return '**No violations found**, but some checks could not be completed (see below).'
  }
  if (detection.aiAssisted) return '**AI-assisted pull request:** all applicable checks passed.'
  return '**No AI assistance detected.** AI-specific rules were not applied.'
}

export function renderReport(input: ReportInput): string {
  const { policy, detection, results } = input
  const out: string[] = []
  out.push('## AI Contribution Check', '')
  out.push(headline(input), '')

  out.push('### AI assistance')
  if (detection.aiAssisted) {
    out.push('Treated as AI-assisted because of:')
    for (const s of detection.positive.slice(0, 15)) out.push(`- ${describeSignal(s)}: ${code(s.evidence)}`)
    if (detection.positive.length > 15) out.push(`- and ${detection.positive.length - 15} more`)
  } else {
    out.push('No disclosure, AI trailer, AI tool identity or AI agent account was found.')
  }
  if (detection.negative.length > 0) {
    out.push('', 'Statements that AI was not used:')
    for (const s of detection.negative.slice(0, 5)) out.push(`- ${s.location}: ${code(s.evidence)}`)
  }
  out.push('')

  const visible = [...results]
    .filter((r) => r.status !== 'skipped')
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
  const skipped = results.filter((r) => r.status === 'skipped')
  if (visible.length > 0 || skipped.length > 0) {
    out.push('### Checks')
    if (skipped.length > 0) {
      out.push(
        `- **${STATUS_LABEL.skipped}** (they apply only to AI-assisted PRs): ${[...new Set(skipped.map((r) => r.title))].join(', ')}.`
      )
    }
    for (const r of visible) {
      if (r.messages.length === 1) {
        out.push(`- **${STATUS_LABEL[r.status]}** · ${r.title}: ${r.messages[0]}`)
      } else {
        out.push(`- **${STATUS_LABEL[r.status]}** · ${r.title}:`)
        for (const m of r.messages.slice(0, 20)) out.push(`  - ${m}`)
        if (r.messages.length > 20) out.push(`  - and ${r.messages.length - 20} more`)
      }
    }
    out.push('')
  }

  const notes: string[] = []
  if (policy.ai_use !== 'unspecified') notes.push(`AI use: ${code(policy.ai_use)}.`)
  if (policy.human_only.length > 0) {
    const items = policy.human_only.map((h) => HUMAN_ONLY_LABEL[h] ?? code(h))
    notes.push(`Written by a human, not by AI: ${items.join(', ')}. (Not checked automatically.)`)
  }
  if (policy.cla) notes.push('A CLA is required. (Checked by the project’s CLA tooling, not by this action.)')
  if (notes.length > 0) {
    out.push('### Policy notes')
    for (const n of notes) out.push(`- ${n}`)
    out.push('')
  }

  out.push(
    `<sub>Policy: ${code(input.policyPath)}. This check reads pull request metadata only. ` +
      'It cannot detect AI use that was not disclosed, and its detection is heuristic: ' +
      'a maintainer makes the final call.</sub>'
  )
  return out.join('\n') + '\n'
}
