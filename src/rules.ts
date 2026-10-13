// Rule evaluation. Pure: policy + detection + PR data in, results out.

import { classifyIdentity } from './identities.js'
import { formatRef } from './references.js'
import { aiTrailers, signOffs } from './trailers.js'
import { canonicalKey, shortSha } from './detect.js'
import { code, hasImage } from './text.js'
import type {
  CommitInfo,
  Detection,
  DisclosureLocation,
  LinkedIssue,
  Policy,
  PullRequestData,
  RuleResult,
  Signal
} from './types.js'

const LOCATION_LABEL: Record<DisclosureLocation, string> = {
  description: 'the PR description',
  checkbox: 'a ticked checkbox in the PR template',
  'commit-trailer': 'a commit trailer'
}

export function describeSignal(s: Signal): string {
  const tool = s.tool && !s.tool.startsWith('AI (') ? ` (${s.tool})` : ''
  switch (s.kind) {
    case 'description-statement':
      return `${s.location}: statement${tool}`
    case 'description-trailer':
      return `${s.location}: ${canonicalKey(s.trailerKey ?? 'trailer')} line${tool}`
    case 'checkbox':
      return `${s.location}: ticked checkbox${tool}`
    case 'commit-trailer':
      return `${s.location}: ${canonicalKey(s.trailerKey ?? 'trailer')} trailer${tool}`
    case 'commit-attribution':
      return `${s.location}: tool attribution line${tool}`
    case 'commit-author':
      return `${s.location}: authored by an AI tool identity${tool}`
    case 'bot-author':
      return `${s.location}: AI agent account`
  }
}

function isMerge(c: CommitInfo): boolean {
  return c.parentCount > 1
}

/** Location(s) where the PR discloses AI use in a way the policy accepts. */
export function disclosureLocationsFound(policy: Policy, detection: Detection): DisclosureLocation[] {
  const found = new Set<DisclosureLocation>()
  for (const s of detection.positive) {
    if (s.kind === 'description-statement' || s.kind === 'description-trailer') found.add('description')
    if (s.kind === 'checkbox') found.add('checkbox')
    if (s.kind === 'commit-trailer') {
      const key = s.trailerKey
      const banned =
        (key === 'assisted-by' && policy.trailers.assisted_by === 'banned') ||
        (key === 'co-authored-by' && policy.trailers.co_authored_by_ai === 'banned')
      if (!banned) found.add('commit-trailer')
    }
  }
  return [...found]
}

function labelGroupsText(groups: string[][]): string {
  return groups
    .map((g) => (g.length === 1 ? code(g[0] ?? '') : `one of (${g.map(code).join(', ')})`))
    .join(' AND ')
}

function missingGroups(issue: LinkedIssue, groups: string[][]): string[][] {
  const have = new Set(issue.labels.map((l) => l.trim().toLowerCase()))
  return groups.filter((g) => !g.some((l) => have.has(l.trim().toLowerCase())))
}

export function evaluate(policy: Policy, detection: Detection, pr: PullRequestData): RuleResult[] {
  const results: RuleResult[] = []
  const ai = detection.aiAssisted
  const base = { owner: pr.owner, repo: pr.repo }
  const skippedMsg = 'No AI assistance detected, so this rule does not apply.'
  const nonMerge = pr.commits.filter((c) => !isMerge(c))

  // Coverage first: a partial commit list must never read as "clean".
  if (pr.totalCommits > pr.commits.length) {
    results.push({
      id: 'commit-coverage',
      title: 'Commit coverage',
      status: 'unverified',
      messages: [
        `Only ${pr.commits.length} of ${pr.totalCommits} commits could be read (GitHub API limit); ` +
          'commit rules were checked on those only.'
      ]
    })
  }

  // ai_use
  if (policy.ai_use === 'banned' || policy.ai_use === 'restricted') {
    const title = 'AI use'
    if (!ai) {
      results.push({ id: 'ai-use', title, status: 'skipped', messages: [skippedMsg] })
    } else if (policy.ai_use === 'banned') {
      results.push({
        id: 'ai-use',
        title,
        status: 'violation',
        messages: ['This pull request indicates AI assistance, and the project policy does not accept AI-assisted contributions (`ai_use: banned`).']
      })
    } else {
      results.push({
        id: 'ai-use',
        title,
        status: 'notice',
        messages: ['The project policy restricts AI-assisted contributions (`ai_use: restricted`).']
      })
    }
  }

  // disclosure
  if (policy.disclosure.required) {
    const where = policy.disclosure.where
    const whereText = where.map((w) => LOCATION_LABEL[w]).join(' or ')
    const example = policy.disclosure.example ? ` Example: ${code(policy.disclosure.example)}` : ''
    if (!ai) {
      results.push({
        id: 'disclosure',
        title: 'AI disclosure',
        status: 'notice',
        messages: [
          `No AI-assistance disclosure found. If AI tools were used, the policy asks for a disclosure in ${whereText}.${example}`
        ]
      })
    } else {
      const found = disclosureLocationsFound(policy, detection).filter((l) => where.includes(l))
      if (found.length > 0) {
        results.push({
          id: 'disclosure',
          title: 'AI disclosure',
          status: 'pass',
          messages: [`Disclosed in ${found.map((l) => LOCATION_LABEL[l]).join(' and ')}.`]
        })
      } else {
        const evidence = detection.positive.slice(0, 3).map(describeSignal).join('; ')
        results.push({
          id: 'disclosure',
          title: 'AI disclosure',
          status: 'violation',
          messages: [
            `AI assistance is indicated (${evidence}), but the policy asks for a disclosure in ${whereText} and none was found there.${example}`
          ]
        })
      }
    }
  }

  // Contradicting statements are worth a maintainer's attention, never an accusation.
  if (ai && detection.negative.length > 0) {
    const neg = detection.negative[0]
    const pos = detection.positive[0]
    if (neg && pos) {
      results.push({
        id: 'consistency',
        title: 'Consistency',
        status: 'notice',
        messages: [
          `${neg.location} says AI was not used (${code(neg.evidence)}), but ${describeSignal(pos)} indicates AI assistance. One of them may be out of date.`
        ]
      })
    }
  }

  // Assisted-by trailers
  const assisted = policy.trailers.assisted_by
  if (assisted === 'required' || assisted === 'banned') {
    const title = 'Assisted-by trailer'
    const withTrailer = (c: CommitInfo): boolean => aiTrailers(c.message).some((t) => t.key === 'assisted-by')
    if (assisted === 'banned') {
      const offenders = pr.commits.filter(withTrailer)
      results.push(
        offenders.length > 0
          ? {
              id: 'assisted-by-trailer',
              title,
              status: 'violation',
              messages: offenders.map(
                (c) => `Commit ${shortSha(c.sha)} has an \`Assisted-by\` trailer; the policy does not allow it.`
              )
            }
          : { id: 'assisted-by-trailer', title, status: 'pass', messages: ['No commit has an `Assisted-by` trailer.'] }
      )
    } else if (!ai) {
      results.push({ id: 'assisted-by-trailer', title, status: 'skipped', messages: [skippedMsg] })
    } else {
      const missing = nonMerge.filter((c) => !withTrailer(c))
      results.push(
        missing.length > 0
          ? {
              id: 'assisted-by-trailer',
              title,
              status: 'violation',
              messages: missing.map(
                (c) => `Commit ${shortSha(c.sha)} has no \`Assisted-by\` trailer; the policy requires one on every commit of an AI-assisted PR.`
              )
            }
          : {
              id: 'assisted-by-trailer',
              title,
              status: 'pass',
              messages: [`All ${nonMerge.length} non-merge commit(s) have an \`Assisted-by\` trailer.`]
            }
      )
    }
  }

  // Co-authored-by naming an AI tool
  if (policy.trailers.co_authored_by_ai === 'banned') {
    const title = 'AI co-author trailer'
    const offenders: string[] = []
    for (const c of pr.commits) {
      for (const t of aiTrailers(c.message)) {
        if (t.key === 'co-authored-by') {
          offenders.push(
            `Commit ${shortSha(c.sha)} lists ${t.tool ?? 'an AI tool'} as a co-author (${code(`Co-authored-by: ${t.value}`)}); the policy does not allow AI co-author trailers.`
          )
        }
      }
    }
    results.push(
      offenders.length > 0
        ? { id: 'co-authored-by-ai', title, status: 'violation', messages: offenders }
        : { id: 'co-authored-by-ai', title, status: 'pass', messages: ['No commit lists an AI tool as co-author.'] }
    )
  }

  // DCO sign-off
  if (policy.dco) {
    const title = 'DCO sign-off'
    if (!ai) {
      results.push({ id: 'dco', title, status: 'skipped', messages: [skippedMsg] })
    } else {
      const messages: string[] = []
      for (const c of nonMerge) {
        const offs = signOffs(c.message)
        const aiOffs = offs.filter((o) => classifyIdentity(o.name, o.email))
        const human = offs.filter((o) => !classifyIdentity(o.name, o.email))
        if (aiOffs.length > 0) {
          messages.push(
            `Commit ${shortSha(c.sha)} has a \`Signed-off-by\` from an AI tool (${aiOffs.map((o) => code(o.raw)).join(', ')}); only a human can certify the DCO.`
          )
        }
        if (human.length === 0) {
          if (aiOffs.length === 0) messages.push(`Commit ${shortSha(c.sha)} has no \`Signed-off-by\` line.`)
        } else if (!human.some((o) => o.email.toLowerCase() === c.authorEmail.toLowerCase())) {
          messages.push(
            `Commit ${shortSha(c.sha)} is signed off by ${human.map((o) => code(o.email)).join(', ')}, which does not match the commit author email ${code(c.authorEmail)}.`
          )
        }
      }
      results.push(
        messages.length > 0
          ? { id: 'dco', title, status: 'violation', messages }
          : { id: 'dco', title, status: 'pass', messages: [`All ${nonMerge.length} non-merge commit(s) are signed off by their author.`] }
      )
    }
  }

  // Signed commits
  if (policy.signed_commits) {
    const title = 'Signed commits'
    if (!ai) {
      results.push({ id: 'signed-commits', title, status: 'skipped', messages: [skippedMsg] })
    } else {
      const unsigned = pr.commits.filter((c) => !c.verified)
      results.push(
        unsigned.length > 0
          ? {
              id: 'signed-commits',
              title,
              status: 'violation',
              messages: unsigned.map(
                (c) => `Commit ${shortSha(c.sha)} does not have a verified signature (GitHub reports: ${code(c.verificationReason)}).`
              )
            }
          : { id: 'signed-commits', title, status: 'pass', messages: [`All ${pr.commits.length} commit(s) have verified signatures.`] }
      )
    }
  }

  results.push(...evaluateLinkedIssues(policy, ai, pr, base, skippedMsg))

  // UI screenshots: the action cannot tell whether a PR changes UI, so this is advisory.
  if (policy.ui_screenshots_required) {
    const title = 'UI screenshots'
    if (!ai) {
      results.push({ id: 'ui-screenshots', title, status: 'skipped', messages: [skippedMsg] })
    } else if (hasImage(pr.body)) {
      results.push({ id: 'ui-screenshots', title, status: 'pass', messages: ['The description contains an image or video.'] })
    } else {
      results.push({
        id: 'ui-screenshots',
        title,
        status: 'notice',
        messages: ['The policy asks for screenshots of UI changes. No image was found in the description; this matters only if the PR changes UI.']
      })
    }
  }

  return results
}

function evaluateLinkedIssues(
  policy: Policy,
  ai: boolean,
  pr: PullRequestData,
  base: { owner: string; repo: string },
  skippedMsg: string
): RuleResult[] {
  const wantsIssue = policy.issue_first || policy.required_labels.length > 0 || policy.assignment_required
  if (!wantsIssue) return []
  if (!ai) {
    const results: RuleResult[] = []
    if (policy.issue_first) results.push({ id: 'linked-issue', title: 'Linked issue', status: 'skipped', messages: [skippedMsg] })
    if (policy.required_labels.length > 0)
      results.push({ id: 'required-labels', title: 'Issue labels', status: 'skipped', messages: [skippedMsg] })
    if (policy.assignment_required)
      results.push({ id: 'assignment', title: 'Issue assignment', status: 'skipped', messages: [skippedMsg] })
    return results
  }

  const issues = pr.linkedIssues
  const failures = pr.issueLookupFailures
  const failureText = failures.map((f) => `${formatRef(f.ref, base)} (${f.reason})`).join(', ')
  const results: RuleResult[] = []

  if (issues.length === 0) {
    if (failures.length > 0 || pr.linkedIssueQueryError) {
      const why = failures.length > 0 ? `could not read ${failureText}` : `GitHub's linked-issue query failed (${pr.linkedIssueQueryError})`
      results.push({
        id: 'linked-issue',
        title: 'Linked issue',
        status: 'unverified',
        messages: [`No linked issue could be confirmed: ${why}.`]
      })
    } else {
      results.push({
        id: 'linked-issue',
        title: 'Linked issue',
        status: 'violation',
        messages: ['No linked issue found. Link the issue this PR addresses with a closing keyword, e.g. `Fixes #123`.']
      })
    }
    return results
  }

  if (policy.issue_first) {
    results.push({
      id: 'linked-issue',
      title: 'Linked issue',
      status: 'pass',
      messages: [`Linked: ${issues.map((i) => formatRef(i, base)).join(', ')}.`]
    })
  }

  if (failures.length > 0) {
    results.push({
      id: 'linked-issue',
      title: 'Linked issue',
      status: 'unverified',
      messages: [`Could not read some linked issues, so they were not checked: ${failureText}.`]
    })
  }

  if (policy.required_labels.length > 0) {
    const needed = labelGroupsText(policy.required_labels)
    const messages: string[] = []
    for (const issue of issues) {
      const missing = missingGroups(issue, policy.required_labels)
      if (missing.length > 0) {
        const has = issue.labels.length > 0 ? issue.labels.map(code).join(', ') : 'no labels'
        messages.push(
          `Issue ${formatRef(issue, base)} is not open to AI-assisted contributions under this policy: it needs ${needed}, and it has ${has}.`
        )
      }
    }
    results.push(
      messages.length > 0
        ? { id: 'required-labels', title: 'Issue labels', status: 'violation', messages }
        : {
            id: 'required-labels',
            title: 'Issue labels',
            status: 'pass',
            messages: [`Linked issue(s) carry the required labels (${needed}).`]
          }
    )
  }

  if (policy.assignment_required) {
    const author = pr.authorLogin.toLowerCase()
    const messages = issues
      .filter((i) => !i.assignees.some((a) => a.toLowerCase() === author))
      .map((i) => {
        const who = i.assignees.length > 0 ? `assigned to ${i.assignees.map((a) => code(`@${a}`)).join(', ')}` : 'unassigned'
        return `Issue ${formatRef(i, base)} is ${who}; the policy requires it to be assigned to the PR author before a PR is opened.`
      })
    results.push(
      messages.length > 0
        ? { id: 'assignment', title: 'Issue assignment', status: 'violation', messages }
        : { id: 'assignment', title: 'Issue assignment', status: 'pass', messages: ['Linked issue(s) are assigned to the PR author.'] }
    )
  }
  return results
}

export function countViolations(results: RuleResult[]): number {
  return results.filter((r) => r.status === 'violation').reduce((n, r) => n + r.messages.length, 0)
}
