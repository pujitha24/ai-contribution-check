import { describe, expect, it } from 'vitest'
import type { GitHubClient } from '../src/github.js'
import { parseInputs, runCheck, type Inputs, type Io, type RunContext } from '../src/main.js'
import { COMMENT_MARKER } from '../src/report.js'
import type { CommitInfo, IssueRef, LinkedIssue } from '../src/types.js'
import { commit, issue } from './helpers.js'

interface FakeState {
  policy: string | null
  body: string
  author: string
  commits: CommitInfo[]
  closing: LinkedIssue[]
  issues: Record<number, LinkedIssue | 'error'>
  comment: { id: number; body: string } | null
  commentError?: boolean
}

function fakeClient(state: FakeState): GitHubClient & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    getFile: async (path, ref) => {
      calls.push(`getFile ${path}@${ref}`)
      return state.policy
    },
    getPull: async () => ({ body: state.body, authorLogin: state.author, totalCommits: state.commits.length }),
    listCommits: async () => state.commits,
    closingIssues: async () => state.closing,
    getIssue: async (ref: IssueRef) => {
      const found = state.issues[ref.number]
      if (found === 'error' || found === undefined) throw Object.assign(new Error('Not Found'), { status: 404 })
      return found
    },
    findComment: async (_n, marker) => {
      if (state.commentError) throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 })
      return state.comment?.body.includes(marker) ? { id: state.comment.id } : null
    },
    createComment: async (_n, body) => {
      calls.push('createComment')
      state.comment = { id: 1, body }
    },
    updateComment: async (id, body) => {
      calls.push(`updateComment ${id}`)
      state.comment = { id, body }
    }
  }
}

function recorder(): Io & { log: string[]; outputs: Record<string, string>; summary: string; failed: string | null } {
  const rec = {
    log: [] as string[],
    outputs: {} as Record<string, string>,
    summary: '',
    failed: null as string | null,
    setOutput(name: string, value: string) {
      rec.outputs[name] = value
    },
    info(m: string) {
      rec.log.push(`info: ${m}`)
    },
    notice(m: string) {
      rec.log.push(`notice: ${m}`)
    },
    warning(m: string) {
      rec.log.push(`warning: ${m}`)
    },
    error(m: string) {
      rec.log.push(`error: ${m}`)
    },
    setFailed(m: string) {
      rec.failed = m
    },
    async writeSummary(md: string) {
      rec.summary += md
    }
  }
  return rec
}

const ctx: RunContext = {
  eventName: 'pull_request_target',
  owner: 'acme',
  repo: 'widgets',
  pullNumber: 7,
  baseSha: 'basesha',
  serverUrl: 'https://github.com'
}

const inputs: Inputs = { policyFile: '.github/ai-policy.yml', failOn: 'violation', comment: false, botAuthors: [] }

const RADIUS = `version: 1
ai_use: restricted
disclosure: { required: true, where: [description] }
issue_first: true
required_labels: [[triaged], [help wanted, good first issue]]
`

function state(overrides: Partial<FakeState> = {}): FakeState {
  return {
    policy: RADIUS,
    body: 'I used Claude Code for the first draft of this change. Fixes #5',
    author: 'ada',
    commits: [commit('Add retries')],
    closing: [],
    issues: { 5: issue(5, { labels: ['bug'] }) },
    comment: null,
    ...overrides
  }
}

describe('parseInputs', () => {
  it('applies defaults and validates', () => {
    const i = parseInputs(() => '')
    expect(i).toMatchObject({ policyFile: '.github/ai-policy.yml', failOn: 'violation', comment: false })
    expect(i.botAuthors).toContain('copilot-swe-agent[bot]')
    expect(parseInputs((n) => (n === 'bot-authors' ? 'a[bot], b\n# note\nc' : '')).botAuthors.slice(-3)).toEqual([
      'a[bot]',
      'b',
      'c'
    ])
    expect(() => parseInputs((n) => (n === 'fail-on' ? 'warning' : ''))).toThrow(/fail-on/)
    expect(() => parseInputs((n) => (n === 'comment' ? 'yes' : ''))).toThrow(/comment/)
  })
})

describe('runCheck', () => {
  it('reads the policy from the base commit and fails on violations', async () => {
    const client = fakeClient(state())
    const io = recorder()
    const r = await runCheck(ctx, inputs, client, io)
    expect(client.calls[0]).toBe('getFile .github/ai-policy.yml@basesha')
    expect(r).toMatchObject({ checked: true, aiAssisted: true, violations: 1 })
    expect(io.outputs).toMatchObject({ 'ai-assisted': 'true', violations: '1' })
    expect(io.failed).toMatch(/1 AI contribution policy violation/)
    expect(io.summary).toContain('Issue #5 is not open to AI-assisted contributions')
    expect(io.log.some((l) => l.startsWith('error: Issue #5'))).toBe(true)
  })

  it('fail-on: never reports without failing', async () => {
    const io = recorder()
    await runCheck(ctx, { ...inputs, failOn: 'never' }, fakeClient(state()), io)
    expect(io.outputs.violations).toBe('1')
    expect(io.failed).toBeNull()
  })

  it('a human PR with no disclosure gets a notice, not a failure', async () => {
    const io = recorder()
    const r = await runCheck(ctx, inputs, fakeClient(state({ body: 'Adds retries. Fixes #5' })), io)
    expect(r).toMatchObject({ aiAssisted: false, violations: 0 })
    expect(io.failed).toBeNull()
    expect(io.log).toContain(
      'notice: No AI-assistance disclosure found. If AI tools were used, the policy asks for a disclosure in the PR description.'
    )
  })

  it('missing policy: warns, does not fail, does not set check outputs', async () => {
    const io = recorder()
    const r = await runCheck(ctx, inputs, fakeClient(state({ policy: null })), io)
    expect(r.checked).toBe(false)
    expect(io.failed).toBeNull()
    expect(io.outputs.violations).toBeUndefined()
    expect(io.summary).toMatch(/Not checked/)
  })

  it('invalid policy: fails under fail-on violation', async () => {
    const io = recorder()
    await runCheck(ctx, inputs, fakeClient(state({ policy: 'version: 3\n' })), io)
    expect(io.failed).toMatch(/Invalid policy file/)
    expect(io.log.some((l) => l.includes('Unsupported policy version 3'))).toBe(true)
  })

  it('ignores events without a pull request', async () => {
    const io = recorder()
    const r = await runCheck({ ...ctx, eventName: 'push', pullNumber: null, baseSha: null }, inputs, fakeClient(state()), io)
    expect(r.checked).toBe(false)
    expect(io.log[0]).toMatch(/^warning: This action checks pull requests/)
  })

  it('unreadable linked issue is reported as not verified', async () => {
    const io = recorder()
    const r = await runCheck(ctx, inputs, fakeClient(state({ issues: { 5: 'error' } })), io)
    expect(r.violations).toBe(0)
    expect(io.summary).toMatch(/could not be completed/)
    expect(io.log.some((l) => l.startsWith('warning: No linked issue could be confirmed: could not read #5'))).toBe(true)
  })

  describe('sticky comment', () => {
    it('creates one comment, then updates it in place', async () => {
      const s = state()
      const client = fakeClient(s)
      await runCheck(ctx, { ...inputs, comment: true }, client, recorder())
      expect(client.calls).toContain('createComment')
      expect(s.comment?.body.startsWith(COMMENT_MARKER)).toBe(true)

      s.issues = { 5: issue(5, { labels: ['triaged', 'help wanted'] }) }
      await runCheck(ctx, { ...inputs, comment: true }, client, recorder())
      expect(client.calls.filter((c) => c === 'createComment')).toHaveLength(1)
      expect(client.calls).toContain('updateComment 1')
      expect(s.comment?.body).toContain('all applicable checks passed')
    })

    it('does not comment on a clean PR', async () => {
      const client = fakeClient(state({ body: 'Adds retries. Fixes #5' }))
      await runCheck(ctx, { ...inputs, comment: true }, client, recorder())
      expect(client.calls).not.toContain('createComment')
    })

    it('a comment permission error is a warning, not a crash', async () => {
      const io = recorder()
      await runCheck(ctx, { ...inputs, comment: true, failOn: 'never' }, fakeClient(state({ commentError: true })), io)
      expect(io.log.some((l) => l.startsWith('warning: Could not post the comment (HTTP 403'))).toBe(true)
    })
  })
})
