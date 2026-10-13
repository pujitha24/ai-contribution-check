import { describe, expect, it } from 'vitest'
import { formatRef, parseClosingReferences } from '../src/references.js'

const base = { owner: 'acme', repo: 'widgets' }

describe('parseClosingReferences', () => {
  it('finds closing keywords in all their forms', () => {
    const body = [
      'Fixes #12',
      'closes acme/gadgets#3 and resolves: #4',
      'Resolved https://github.com/other/repo/issues/99',
      'FIXED #12 (duplicate)'
    ].join('\n')
    expect(parseClosingReferences(body, base)).toEqual([
      { owner: 'acme', repo: 'widgets', number: 12 },
      { owner: 'acme', repo: 'gadgets', number: 3 },
      { owner: 'acme', repo: 'widgets', number: 4 },
      { owner: 'other', repo: 'repo', number: 99 }
    ])
  })

  it('ignores non-closing references, comments, code and pull URLs', () => {
    const body = [
      'Refs #1, part of #2, see #3',
      '<!-- Fixes #4 -->',
      '`fixes #5`',
      '```',
      'Fixes #6',
      '```',
      'Fixes https://github.com/acme/widgets/pull/7',
      'prefixes #8'
    ].join('\n')
    expect(parseClosingReferences(body, base)).toEqual([])
  })

  it('accepts issue URLs on a GitHub Enterprise host', () => {
    expect(parseClosingReferences('Fixes https://ghe.example.com/a/b/issues/5', base, 'ghe.example.com')).toEqual([
      { owner: 'a', repo: 'b', number: 5 }
    ])
  })

  it('formats local and cross-repo references', () => {
    expect(formatRef({ owner: 'Acme', repo: 'Widgets', number: 1 }, base)).toBe('#1')
    expect(formatRef({ owner: 'x', repo: 'y', number: 2 }, base)).toBe('x/y#2')
  })
})
