import { describe, expect, it } from 'vitest'
import { detectAiAssistance } from '../src/detect.js'
import { renderReport } from '../src/report.js'
import { countViolations, evaluate } from '../src/rules.js'
import { code } from '../src/text.js'
import { commit, policy, pull } from './helpers.js'

describe('report', () => {
  it('renders detection, checks and policy notes', () => {
    const p = policy({
      ai_use: 'disclose',
      disclosure: { required: true, where: ['description'], example: null },
      trailers: { assisted_by: 'banned', co_authored_by_ai: 'banned' },
      human_only: ['review-replies'],
      cla: true
    })
    const pr = pull({ commits: [commit('Add\n\nCo-authored-by: Claude <noreply@anthropic.com>')] })
    const detection = detectAiAssistance({ body: pr.body, authorLogin: pr.authorLogin, commits: pr.commits, botAuthors: [] })
    const results = evaluate(p, detection, pr)
    const md = renderReport({ policyPath: '.github/ai-policy.yml', policy: p, detection, results, violations: countViolations(results) })

    expect(md).toContain('**2 policy violations** found.')
    expect(md).toMatch(/- commit [0-9a-f]{7}: Co-authored-by trailer \(Claude\): `Co-authored-by: Claude <noreply@anthropic.com>`/)
    expect(md).toContain('- **Violation** · AI disclosure:')
    expect(md).toContain('- **Pass** · Assisted-by trailer')
    expect(md).toContain('Written by a human, not by AI: replies to review comments.')
    expect(md).toContain('cannot detect AI use that was not disclosed')
    // Violations are listed before passes.
    expect(md.indexOf('**Violation**')).toBeLessThan(md.indexOf('**Pass**'))
  })

  it('collapses skipped rules into one line for human PRs', () => {
    const p = policy({ dco: true, signed_commits: true })
    const pr = pull()
    const detection = detectAiAssistance({ body: '', authorLogin: 'ada', commits: pr.commits, botAuthors: [] })
    const md = renderReport({ policyPath: 'p.yml', policy: p, detection, results: evaluate(p, detection, pr), violations: 0 })
    expect(md).toContain('**No AI assistance detected.**')
    expect(md).toContain('- **Skipped** (they apply only to AI-assisted PRs): DCO sign-off, Signed commits.')
  })

  it('neutralises untrusted text', () => {
    expect(code('ping @maintainers `rm -rf` <img src=x>\n| x')).toBe("`ping @maintainers 'rm -rf' <img src=x> | x`")
  })
})
