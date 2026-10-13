import { defaultPolicy } from '../src/policy.js'
import type { CommitInfo, LinkedIssue, Policy, PullRequestData } from '../src/types.js'

let counter = 0

export function commit(message: string, overrides: Partial<CommitInfo> = {}): CommitInfo {
  counter += 1
  return {
    sha: (counter.toString(16).padStart(7, '0') + 'a'.repeat(33)).slice(0, 40),
    message,
    authorName: 'Ada Lovelace',
    authorEmail: 'ada@example.com',
    authorLogin: 'ada',
    committerName: 'Ada Lovelace',
    committerEmail: 'ada@example.com',
    verified: true,
    verificationReason: 'valid',
    parentCount: 1,
    ...overrides
  }
}

export function issue(number: number, overrides: Partial<LinkedIssue> = {}): LinkedIssue {
  return { owner: 'acme', repo: 'widgets', number, state: 'open', labels: [], assignees: [], ...overrides }
}

export function pull(overrides: Partial<PullRequestData> = {}): PullRequestData {
  const commits = overrides.commits ?? [commit('Fix widget\n\nSigned-off-by: Ada Lovelace <ada@example.com>')]
  return {
    owner: 'acme',
    repo: 'widgets',
    number: 7,
    body: '',
    authorLogin: 'ada',
    totalCommits: commits.length,
    linkedIssues: [],
    issueLookupFailures: [],
    linkedIssueQueryError: null,
    ...overrides,
    commits
  }
}

export function policy(overrides: Partial<Policy> = {}): Policy {
  return { ...defaultPolicy(), ...overrides }
}
