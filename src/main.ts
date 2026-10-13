// Orchestration: read inputs, fetch data, evaluate, report. All side effects go
// through `Io` and `GitHubClient`, so this can be tested without a runner.

import { detectAiAssistance } from './detect.js'
import { errorMessage, gatherPullRequest, type GitHubClient } from './github.js'
import { DEFAULT_BOT_AUTHORS, parseLoginList } from './identities.js'
import { parsePolicy } from './policy.js'
import { COMMENT_MARKER, renderReport } from './report.js'
import { countViolations, evaluate } from './rules.js'
import type { RuleResult } from './types.js'

export interface Inputs {
  policyFile: string
  failOn: 'violation' | 'never'
  comment: boolean
  botAuthors: string[]
}

export interface RunContext {
  eventName: string
  owner: string
  repo: string
  pullNumber: number | null
  baseSha: string | null
  serverUrl: string
}

export interface Io {
  setOutput(name: string, value: string): void
  info(message: string): void
  notice(message: string, title?: string): void
  warning(message: string, title?: string): void
  error(message: string, title?: string): void
  setFailed(message: string): void
  writeSummary(markdown: string): Promise<void>
}

export interface RunResult {
  checked: boolean
  aiAssisted: boolean
  violations: number
  report: string
}

const SUPPORTED_EVENTS = ['pull_request', 'pull_request_target']

export function parseInputs(get: (name: string) => string): Inputs {
  const failOn = (get('fail-on') || 'violation').trim().toLowerCase()
  if (failOn !== 'violation' && failOn !== 'never') {
    throw new Error(`Input fail-on must be "violation" or "never" (got "${failOn}")`)
  }
  const comment = (get('comment') || 'false').trim().toLowerCase()
  if (!['true', 'false'].includes(comment)) {
    throw new Error(`Input comment must be true or false (got "${comment}")`)
  }
  return {
    policyFile: (get('policy-file') || '.github/ai-policy.yml').trim(),
    failOn,
    comment: comment === 'true',
    botAuthors: [...DEFAULT_BOT_AUTHORS, ...parseLoginList(get('bot-authors'))]
  }
}

function annotate(io: Io, results: RuleResult[]): void {
  for (const r of results) {
    for (const m of r.messages) {
      const title = `AI policy: ${r.title}`
      if (r.status === 'violation') io.error(m, title)
      else if (r.status === 'unverified') io.warning(m, title)
      else if (r.status === 'notice') io.notice(m, title)
    }
  }
}

async function postStickyComment(
  client: GitHubClient,
  io: Io,
  number: number,
  report: string,
  hasFindings: boolean
): Promise<void> {
  const body = `${COMMENT_MARKER}\n${report}`
  try {
    const existing = await client.findComment(number, COMMENT_MARKER)
    if (existing) {
      await client.updateComment(existing.id, body)
      io.info(`Updated comment ${existing.id}.`)
    } else if (hasFindings) {
      await client.createComment(number, body)
      io.info('Posted comment.')
    } else {
      io.info('Nothing to report; no comment posted.')
    }
  } catch (err) {
    io.warning(
      `Could not post the comment (${errorMessage(err)}). The token needs "pull-requests: write"; ` +
        'pull requests from forks get a read-only token under the pull_request event.',
      'AI policy: comment'
    )
  }
}

export async function runCheck(
  ctx: RunContext,
  inputs: Inputs,
  client: GitHubClient,
  io: Io
): Promise<RunResult> {
  const notChecked = (report: string): RunResult => ({ checked: false, aiAssisted: false, violations: 0, report })

  if (!SUPPORTED_EVENTS.includes(ctx.eventName) || ctx.pullNumber === null || ctx.baseSha === null) {
    io.warning(
      `This action checks pull requests; the "${ctx.eventName}" event has no pull request. Nothing was checked.`,
      'AI policy: not run'
    )
    return notChecked('')
  }

  // Read the policy from the base commit, never from the PR head: the PR must
  // not be able to change the rules it is checked against.
  const policyText = await client.getFile(inputs.policyFile, ctx.baseSha)
  if (policyText === null) {
    const msg = `No policy file at ${inputs.policyFile} on the base branch, so nothing was checked.`
    io.warning(msg, 'AI policy: not run')
    const report = `## AI Contribution Check\n\n**Not checked:** ${msg}\n`
    await io.writeSummary(report)
    io.setOutput('report', report)
    return notChecked(report)
  }

  const parsed = parsePolicy(policyText)
  for (const w of parsed.warnings) io.warning(`${inputs.policyFile}: ${w}`, 'AI policy: policy file')
  if (!parsed.policy) {
    for (const e of parsed.errors) io.error(`${inputs.policyFile}: ${e}`, 'AI policy: invalid policy file')
    const report =
      `## AI Contribution Check\n\n**Not checked:** the policy file ${inputs.policyFile} is invalid:\n\n` +
      parsed.errors.map((e) => `- ${e}`).join('\n') +
      '\n'
    await io.writeSummary(report)
    io.setOutput('report', report)
    if (inputs.failOn === 'violation') io.setFailed(`Invalid policy file ${inputs.policyFile}`)
    return notChecked(report)
  }
  const policy = parsed.policy

  const serverHost = new URL(ctx.serverUrl).host
  const needIssues = policy.issue_first || policy.required_labels.length > 0 || policy.assignment_required
  const gathered = await gatherPullRequest(client, { owner: ctx.owner, repo: ctx.repo }, ctx.pullNumber, {
    needIssues,
    serverHost
  })
  for (const w of gathered.warnings) io.warning(w, 'AI policy: incomplete data')
  const pr = gathered.pr

  const detection = detectAiAssistance({
    body: pr.body,
    authorLogin: pr.authorLogin,
    commits: pr.commits,
    botAuthors: inputs.botAuthors
  })
  const results = evaluate(policy, detection, pr)
  const violations = countViolations(results)
  const report = renderReport({ policyPath: inputs.policyFile, policy, detection, results, violations })

  io.info(
    `AI assistance: ${detection.aiAssisted ? 'detected' : 'not detected'} ` +
      `(${detection.positive.length} signal(s)); violations: ${violations}`
  )
  annotate(io, results)
  io.setOutput('ai-assisted', String(detection.aiAssisted))
  io.setOutput('violations', String(violations))
  io.setOutput('report', report)
  await io.writeSummary(report)

  if (inputs.comment) {
    const hasFindings = results.some((r) => r.status === 'violation' || r.status === 'unverified')
    await postStickyComment(client, io, ctx.pullNumber, report, hasFindings)
  }

  if (violations > 0 && inputs.failOn === 'violation') {
    io.setFailed(`${violations} AI contribution policy violation(s). See the job summary for details.`)
  }
  return { checked: true, aiAssisted: detection.aiAssisted, violations, report }
}
