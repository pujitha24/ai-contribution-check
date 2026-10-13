// The only module that talks to GitHub. Everything here is read-only except
// the sticky comment, which is opt-in.

import type { getOctokit } from '@actions/github'
import { parseClosingReferences, sameIssue } from './references.js'
import type { CommitInfo, IssueLookupFailure, IssueRef, LinkedIssue, PullRequestData } from './types.js'

type Octokit = ReturnType<typeof getOctokit>

export interface PullSummary {
  body: string
  authorLogin: string
  totalCommits: number
}

/** The GitHub operations the action needs; tests substitute a fake. */
export interface GitHubClient {
  /** File content at a ref, or null if it does not exist. */
  getFile(path: string, ref: string): Promise<string | null>
  getPull(number: number): Promise<PullSummary>
  listCommits(number: number): Promise<CommitInfo[]>
  /** GitHub's own "linked issues" (closingIssuesReferences). */
  closingIssues(number: number): Promise<LinkedIssue[]>
  /** One issue; null if it is a pull request. Throws on API errors. */
  getIssue(ref: IssueRef): Promise<LinkedIssue | null>
  findComment(number: number, marker: string): Promise<{ id: number } | null>
  createComment(number: number, body: string): Promise<void>
  updateComment(id: number, body: string): Promise<void>
}

function status(err: unknown): number | undefined {
  return typeof err === 'object' && err !== null && 'status' in err ? Number(err.status) : undefined
}

export function errorMessage(err: unknown): string {
  const s = status(err)
  const msg = err instanceof Error ? err.message : String(err)
  return s ? `HTTP ${s}: ${msg}` : msg
}

interface ClosingIssuesResponse {
  repository: {
    pullRequest: {
      closingIssuesReferences: {
        nodes: {
          number: number
          state: string
          repository: { name: string; owner: { login: string } }
          labels: { nodes: { name: string }[] }
          assignees: { nodes: { login: string }[] }
        }[]
      }
    } | null
  } | null
}

const CLOSING_ISSUES_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 25) {
        nodes {
          number
          state
          repository { name owner { login } }
          labels(first: 100) { nodes { name } }
          assignees(first: 100) { nodes { login } }
        }
      }
    }
  }
}`

export function createClient(octokit: Octokit, owner: string, repo: string): GitHubClient {
  return {
    async getFile(path, ref) {
      try {
        const res = await octokit.rest.repos.getContent({ owner, repo, path, ref })
        const data = res.data
        if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null
        return Buffer.from(data.content, 'base64').toString('utf8')
      } catch (err) {
        if (status(err) === 404) return null
        throw err
      }
    },

    async getPull(number) {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
      return { body: data.body ?? '', authorLogin: data.user.login, totalCommits: data.commits }
    },

    async listCommits(number) {
      const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
        owner,
        repo,
        pull_number: number,
        per_page: 100
      })
      return commits.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        authorName: c.commit.author?.name ?? '',
        authorEmail: c.commit.author?.email ?? '',
        authorLogin: c.author && 'login' in c.author ? c.author.login : null,
        committerName: c.commit.committer?.name ?? '',
        committerEmail: c.commit.committer?.email ?? '',
        verified: c.commit.verification?.verified ?? false,
        verificationReason: c.commit.verification?.reason ?? 'unknown',
        parentCount: c.parents.length
      }))
    },

    async closingIssues(number) {
      const res = await octokit.graphql<ClosingIssuesResponse>(CLOSING_ISSUES_QUERY, { owner, repo, number })
      const nodes = res.repository?.pullRequest?.closingIssuesReferences.nodes ?? []
      return nodes.map((n) => ({
        owner: n.repository.owner.login,
        repo: n.repository.name,
        number: n.number,
        state: n.state.toLowerCase(),
        labels: n.labels.nodes.map((l) => l.name),
        assignees: n.assignees.nodes.map((a) => a.login)
      }))
    },

    async getIssue(ref) {
      const { data } = await octokit.rest.issues.get({ owner: ref.owner, repo: ref.repo, issue_number: ref.number })
      if (data.pull_request) return null
      return {
        owner: ref.owner,
        repo: ref.repo,
        number: data.number,
        state: data.state,
        labels: data.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter((l) => l),
        assignees: (data.assignees ?? []).map((a) => a.login)
      }
    },

    async findComment(number, marker) {
      const comments = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: number,
        per_page: 100
      })
      const found = comments.find((c) => c.body?.includes(marker))
      return found ? { id: found.id } : null
    },

    async createComment(number, body) {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: number, body })
    },

    async updateComment(id, body) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: id, body })
    }
  }
}

export interface GatherResult {
  pr: PullRequestData
  warnings: string[]
}

/** Collect everything the rules need, recording what could not be read. */
export async function gatherPullRequest(
  client: GitHubClient,
  base: { owner: string; repo: string },
  number: number,
  options: { needIssues: boolean; serverHost: string }
): Promise<GatherResult> {
  const warnings: string[] = []
  const pull = await client.getPull(number)
  const commits = await client.listCommits(number)

  const linkedIssues: LinkedIssue[] = []
  const issueLookupFailures: IssueLookupFailure[] = []
  let linkedIssueQueryError: string | null = null
  if (options.needIssues) {
    try {
      linkedIssues.push(...(await client.closingIssues(number)))
    } catch (err) {
      linkedIssueQueryError = errorMessage(err)
      warnings.push(`Could not query GitHub's linked issues (${linkedIssueQueryError}); using the description only.`)
    }
    for (const ref of parseClosingReferences(pull.body, base, options.serverHost)) {
      if (linkedIssues.some((i) => sameIssue(i, ref))) continue
      try {
        const issue = await client.getIssue(ref)
        if (issue) linkedIssues.push(issue)
      } catch (err) {
        issueLookupFailures.push({ ref, reason: errorMessage(err) })
      }
    }
  }

  return {
    pr: {
      owner: base.owner,
      repo: base.repo,
      number,
      body: pull.body,
      authorLogin: pull.authorLogin,
      totalCommits: pull.totalCommits,
      commits,
      linkedIssues,
      issueLookupFailures,
      linkedIssueQueryError
    },
    warnings
  }
}
