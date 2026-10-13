// Shared data shapes. Everything in here is plain data so the rule logic can
// stay pure and be tested without the GitHub API.

export type AiUse = 'allowed' | 'disclose' | 'restricted' | 'banned' | 'unspecified'
export type DisclosureLocation = 'description' | 'checkbox' | 'commit-trailer'
export type AssistedByRule = 'required' | 'allowed' | 'banned' | 'unspecified'
export type CoAuthoredByAiRule = 'allowed' | 'banned' | 'unspecified'

export interface Policy {
  version: 1
  ai_use: AiUse
  disclosure: {
    required: boolean
    where: DisclosureLocation[]
    example: string | null
  }
  trailers: {
    assisted_by: AssistedByRule
    co_authored_by_ai: CoAuthoredByAiRule
  }
  human_only: string[]
  assignment_required: boolean
  issue_first: boolean
  /** AND of OR-groups, applied to every linked issue. */
  required_labels: string[][]
  dco: boolean
  cla: boolean
  signed_commits: boolean
  ui_screenshots_required: boolean
}

export interface CommitInfo {
  sha: string
  message: string
  authorName: string
  authorEmail: string
  /** GitHub account the author email resolved to, if any. */
  authorLogin: string | null
  committerName: string
  committerEmail: string
  verified: boolean
  /** GitHub's verification reason, e.g. "valid", "unsigned", "unknown_key". */
  verificationReason: string
  parentCount: number
}

export interface LinkedIssue {
  owner: string
  repo: string
  number: number
  state: string
  labels: string[]
  assignees: string[]
}

export interface IssueRef {
  owner: string
  repo: string
  number: number
}

export interface IssueLookupFailure {
  ref: IssueRef
  reason: string
}

export interface PullRequestData {
  owner: string
  repo: string
  number: number
  body: string
  authorLogin: string
  /** Total commits GitHub reports for the PR; may exceed commits.length. */
  totalCommits: number
  commits: CommitInfo[]
  linkedIssues: LinkedIssue[]
  issueLookupFailures: IssueLookupFailure[]
  /** Set when GitHub's linked-issue query failed, so "no linked issue" cannot be trusted. */
  linkedIssueQueryError: string | null
}

export type SignalKind =
  | 'description-statement'
  | 'description-trailer'
  | 'checkbox'
  | 'commit-trailer'
  | 'commit-attribution'
  | 'commit-author'
  | 'bot-author'

export interface Signal {
  kind: SignalKind
  polarity: 'positive' | 'negative'
  /** Where it was found, e.g. "PR description" or "commit 1a2b3c4". */
  location: string
  /** Short excerpt of the text that produced the signal. */
  evidence: string
  /** AI tool named, if one could be identified. */
  tool?: string
  /** For commit-trailer signals: the trailer key, lower-cased. */
  trailerKey?: string
}

export interface Detection {
  aiAssisted: boolean
  positive: Signal[]
  negative: Signal[]
}

export type RuleId =
  | 'ai-use'
  | 'disclosure'
  | 'consistency'
  | 'assisted-by-trailer'
  | 'co-authored-by-ai'
  | 'dco'
  | 'signed-commits'
  | 'linked-issue'
  | 'required-labels'
  | 'assignment'
  | 'ui-screenshots'
  | 'commit-coverage'

export type RuleStatus = 'pass' | 'violation' | 'unverified' | 'notice' | 'skipped'

export interface RuleResult {
  id: RuleId
  title: string
  status: RuleStatus
  /** One entry per finding; each violation entry counts towards the `violations` output. */
  messages: string[]
}
