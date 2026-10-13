import { describe, expect, it } from 'vitest'
import { detectAiAssistance } from '../src/detect.js'
import { DEFAULT_BOT_AUTHORS } from '../src/identities.js'
import { countViolations, evaluate } from '../src/rules.js'
import type { Policy, PullRequestData, RuleResult } from '../src/types.js'
import { commit, issue, policy, pull } from './helpers.js'

function run(p: Policy, pr: PullRequestData): RuleResult[] {
  const detection = detectAiAssistance({
    body: pr.body,
    authorLogin: pr.authorLogin,
    commits: pr.commits,
    botAuthors: DEFAULT_BOT_AUTHORS
  })
  return evaluate(p, detection, pr)
}

function byId(results: RuleResult[], id: string): RuleResult | undefined {
  return results.find((r) => r.id === id)
}

const AI_BODY = 'I used Claude Code to draft this change and reviewed it line by line.'
const SIGNED = 'Signed-off-by: Ada Lovelace <ada@example.com>'

describe('disclosure', () => {
  const p = policy({ disclosure: { required: true, where: ['description'], example: 'AI: <tool>' } })

  it('is a neutral notice when nothing indicates AI', () => {
    const r = byId(run(p, pull({ body: 'Adds retries.' })), 'disclosure')
    expect(r?.status).toBe('notice')
    expect(r?.messages[0]).toMatch(/^No AI-assistance disclosure found\. If AI tools were used/)
  })

  it('passes when the description discloses', () => {
    expect(byId(run(p, pull({ body: AI_BODY })), 'disclosure')?.status).toBe('pass')
  })

  it('is a violation when AI is indicated elsewhere but not disclosed where required', () => {
    const pr = pull({ body: 'Adds retries.', commits: [commit(`Add retries\n\nAssisted-by: Claude:opus\n${SIGNED}`)] })
    const r = byId(run(p, pr), 'disclosure')
    expect(r?.status).toBe('violation')
    expect(r?.messages[0]).toMatch(/Assisted-by trailer \(Claude\)/)
    expect(r?.messages[0]).toMatch(/Example: `AI: <tool>`/)
  })

  it('accepts any of the listed locations', () => {
    const p2 = policy({ disclosure: { required: true, where: ['checkbox', 'commit-trailer'], example: null } })
    const pr = pull({ commits: [commit('Add\n\nAssisted-by: Copilot')] })
    expect(byId(run(p2, pr), 'disclosure')?.status).toBe('pass')
    const box = pull({ body: '- [x] I used AI tools for this PR', commits: [commit('Add', { authorName: 'Ada (aider)' })] })
    expect(byId(run(p2, box), 'disclosure')?.status).toBe('pass')
  })

  it('does not accept a banned trailer as the disclosure', () => {
    const p2 = policy({
      disclosure: { required: true, where: ['commit-trailer'], example: null },
      trailers: { assisted_by: 'banned', co_authored_by_ai: 'unspecified' }
    })
    const pr = pull({ commits: [commit('Add\n\nAssisted-by: Copilot')] })
    expect(byId(run(p2, pr), 'disclosure')?.status).toBe('violation')
  })

  it('notes contradictions without calling them violations', () => {
    const pr = pull({ body: 'No AI was used.', commits: [commit('Add\n\nCo-authored-by: Claude <noreply@anthropic.com>')] })
    const r = byId(run(policy(), pr), 'consistency')
    expect(r?.status).toBe('notice')
    expect(r?.messages[0]).toMatch(/says AI was not used/)
  })
})

describe('ai_use', () => {
  it('banned: violation only when AI is indicated', () => {
    const p = policy({ ai_use: 'banned' })
    expect(byId(run(p, pull({ body: AI_BODY })), 'ai-use')?.status).toBe('violation')
    expect(byId(run(p, pull({ body: 'Adds retries.' })), 'ai-use')?.status).toBe('skipped')
  })
  it('restricted: notice', () => {
    expect(byId(run(policy({ ai_use: 'restricted' }), pull({ body: AI_BODY })), 'ai-use')?.status).toBe('notice')
  })
  it('allowed: no result', () => {
    expect(byId(run(policy({ ai_use: 'allowed' }), pull({ body: AI_BODY })), 'ai-use')).toBeUndefined()
  })
})

describe('trailers', () => {
  it('assisted_by required: every non-merge commit of an AI-assisted PR', () => {
    const p = policy({ trailers: { assisted_by: 'required', co_authored_by_ai: 'unspecified' } })
    const pr = pull({
      commits: [
        commit('One\n\nAssisted-by: Claude:opus'),
        commit('Two'),
        commit("Merge branch 'main'", { parentCount: 2 })
      ]
    })
    const r = byId(run(p, pr), 'assisted-by-trailer')
    expect(r?.status).toBe('violation')
    expect(r?.messages).toHaveLength(1)
    expect(r?.messages[0]).toMatch(/has no `Assisted-by` trailer/)
  })

  it('assisted_by required: skipped for PRs without AI indication', () => {
    const p = policy({ trailers: { assisted_by: 'required', co_authored_by_ai: 'unspecified' } })
    expect(byId(run(p, pull()), 'assisted-by-trailer')?.status).toBe('skipped')
  })

  it('assisted_by banned', () => {
    const p = policy({ trailers: { assisted_by: 'banned', co_authored_by_ai: 'unspecified' } })
    expect(byId(run(p, pull({ commits: [commit('A\n\nAssisted-by: Gemini')] })), 'assisted-by-trailer')?.status).toBe(
      'violation'
    )
    expect(byId(run(p, pull()), 'assisted-by-trailer')?.status).toBe('pass')
  })

  it('co_authored_by_ai banned flags AI co-authors only', () => {
    const p = policy({ trailers: { assisted_by: 'unspecified', co_authored_by_ai: 'banned' } })
    const ai = pull({ commits: [commit('A\n\nCo-Authored-By: Claude <noreply@anthropic.com>')] })
    const r = byId(run(p, ai), 'co-authored-by-ai')
    expect(r?.status).toBe('violation')
    expect(r?.messages[0]).toMatch(/lists Claude as a co-author/)
    const human = pull({ commits: [commit('A\n\nCo-authored-by: Grace Hopper <grace@example.com>')] })
    expect(byId(run(p, human), 'co-authored-by-ai')?.status).toBe('pass')
  })
})

describe('dco', () => {
  const p = policy({ dco: true })
  it('requires a matching sign-off on every non-merge commit', () => {
    const pr = pull({
      body: AI_BODY,
      commits: [
        commit(`Ok\n\n${SIGNED}`),
        commit('Missing'),
        commit('Mismatch\n\nSigned-off-by: Ada <ada@other.example>'),
        commit('Merge', { parentCount: 2 })
      ]
    })
    const r = byId(run(p, pr), 'dco')
    expect(r?.status).toBe('violation')
    expect(r?.messages).toHaveLength(2)
    expect(r?.messages[0]).toMatch(/no `Signed-off-by` line/)
    expect(r?.messages[1]).toMatch(/does not match the commit author email/)
  })

  it('rejects a sign-off by an AI tool', () => {
    const pr = pull({ body: AI_BODY, commits: [commit('A\n\nSigned-off-by: Claude <noreply@anthropic.com>')] })
    const r = byId(run(p, pr), 'dco')
    expect(r?.messages).toEqual([expect.stringMatching(/from an AI tool .*only a human can certify the DCO/)])
  })

  it('is case-insensitive on email and passes clean PRs', () => {
    const pr = pull({ body: AI_BODY, commits: [commit('A\n\nSigned-off-by: Ada Lovelace <ADA@example.com>')] })
    expect(byId(run(p, pr), 'dco')?.status).toBe('pass')
  })
})

describe('signed commits', () => {
  it('flags unverified commits', () => {
    const pr = pull({ body: AI_BODY, commits: [commit('A'), commit('B', { verified: false, verificationReason: 'unsigned' })] })
    const r = byId(run(policy({ signed_commits: true }), pr), 'signed-commits')
    expect(r?.status).toBe('violation')
    expect(r?.messages[0]).toMatch(/GitHub reports: `unsigned`/)
  })
})

describe('linked issues', () => {
  const radius = policy({ issue_first: true, required_labels: [['triaged'], ['help wanted', 'good first issue']] })

  it('violation when no issue is linked', () => {
    const r = run(radius, pull({ body: AI_BODY }))
    expect(byId(r, 'linked-issue')?.status).toBe('violation')
  })

  it('unverified (not violation) when the issue could not be read', () => {
    const pr = pull({
      body: AI_BODY,
      issueLookupFailures: [{ ref: { owner: 'acme', repo: 'widgets', number: 9 }, reason: 'HTTP 404: Not Found' }]
    })
    const r = run(radius, pr)
    expect(byId(r, 'linked-issue')?.status).toBe('unverified')
    expect(countViolations(r)).toBe(0)
  })

  it('unverified when GitHub linked-issue query failed', () => {
    const r = run(radius, pull({ body: AI_BODY, linkedIssueQueryError: 'HTTP 502' }))
    expect(byId(r, 'linked-issue')?.status).toBe('unverified')
  })

  it('applies label groups as AND of ORs, case-insensitively', () => {
    const ok = pull({ body: AI_BODY, linkedIssues: [issue(1, { labels: ['Triaged', 'good first issue'] })] })
    expect(byId(run(radius, ok), 'required-labels')?.status).toBe('pass')
    const missing = pull({ body: AI_BODY, linkedIssues: [issue(2, { labels: ['triaged', 'bug'] })] })
    const r = byId(run(radius, missing), 'required-labels')
    expect(r?.status).toBe('violation')
    expect(r?.messages[0]).toBe(
      'Issue #2 is not open to AI-assisted contributions under this policy: it needs `triaged` AND one of (`help wanted`, `good first issue`), and it has `triaged`, `bug`.'
    )
  })

  it('checks every linked issue', () => {
    const pr = pull({
      body: AI_BODY,
      linkedIssues: [issue(1, { labels: ['triaged', 'help wanted'] }), issue(2, { labels: [] })]
    })
    expect(byId(run(radius, pr), 'required-labels')?.messages).toHaveLength(1)
  })

  it('requires assignment to the PR author', () => {
    const p = policy({ assignment_required: true })
    const pr = pull({ body: AI_BODY, linkedIssues: [issue(1, { assignees: ['grace'] })] })
    const r = byId(run(p, pr), 'assignment')
    expect(r?.status).toBe('violation')
    expect(r?.messages[0]).toMatch(/assigned to `@grace`/)
    const mine = pull({ body: AI_BODY, linkedIssues: [issue(1, { assignees: ['ADA'] })] })
    expect(byId(run(p, mine), 'assignment')?.status).toBe('pass')
  })

  it('skips issue rules when AI is not indicated', () => {
    const r = run(radius, pull({ body: 'Adds retries.' }))
    expect(r.map((x) => x.status)).toEqual(['skipped', 'skipped'])
  })
})

describe('ui screenshots and coverage', () => {
  it('ui screenshots is advisory', () => {
    const p = policy({ ui_screenshots_required: true })
    expect(byId(run(p, pull({ body: AI_BODY })), 'ui-screenshots')?.status).toBe('notice')
    const withImg = pull({ body: `${AI_BODY}\n\n![after](https://github.com/user-attachments/assets/abc)` })
    expect(byId(run(p, withImg), 'ui-screenshots')?.status).toBe('pass')
  })

  it('reports truncated commit lists as unverified', () => {
    const pr = pull({ totalCommits: 300 })
    expect(byId(run(policy(), pr), 'commit-coverage')?.status).toBe('unverified')
  })
})

describe('countViolations', () => {
  it('counts each violation message', () => {
    const p = policy({ dco: true, signed_commits: true })
    const pr = pull({ body: AI_BODY, commits: [commit('A', { verified: false }), commit('B')] })
    expect(countViolations(run(p, pr))).toBe(3)
  })
})
