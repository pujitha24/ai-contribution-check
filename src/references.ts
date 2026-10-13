import { stripNonProse } from './text.js'
import type { IssueRef } from './types.js'

const KEYWORD = String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+`
const SHORT_REF = new RegExp(`${KEYWORD}(?:([\\w.-]+)/([\\w.-]+))?#(\\d+)\\b`, 'gi')

function escapeHost(host: string): string {
  return host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Issues a PR description says it closes, using GitHub's closing keywords
 * ("Fixes #12", "Closes owner/repo#3", "Resolves https://github.com/o/r/issues/4").
 * HTML comments and code are ignored, as GitHub ignores them.
 */
export function parseClosingReferences(
  body: string,
  base: { owner: string; repo: string },
  serverHost = 'github.com'
): IssueRef[] {
  const text = stripNonProse(body)
  const refs: IssueRef[] = []
  const seen = new Set<string>()
  const add = (owner: string, repo: string, number: number): void => {
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`
    if (seen.has(key) || number <= 0) return
    seen.add(key)
    refs.push({ owner, repo, number })
  }

  for (const m of text.matchAll(SHORT_REF)) {
    add(m[1] ?? base.owner, m[2] ?? base.repo, Number(m[3]))
  }

  const hosts = [...new Set(['github.com', serverHost])].map(escapeHost).join('|')
  const urlRef = new RegExp(
    `${KEYWORD}https?://(?:${hosts})/([\\w.-]+)/([\\w.-]+)/issues/(\\d+)\\b`,
    'gi'
  )
  for (const m of text.matchAll(urlRef)) {
    add(m[1] ?? '', m[2] ?? '', Number(m[3]))
  }
  return refs
}

export function sameIssue(a: IssueRef, b: IssueRef): boolean {
  return (
    a.number === b.number &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  )
}

export function formatRef(ref: IssueRef, base: { owner: string; repo: string }): string {
  const local =
    ref.owner.toLowerCase() === base.owner.toLowerCase() &&
    ref.repo.toLowerCase() === base.repo.toLowerCase()
  return local ? `#${ref.number}` : `${ref.owner}/${ref.repo}#${ref.number}`
}
