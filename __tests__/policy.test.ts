import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePolicy } from '../src/policy.js'

const FULL = `
version: 1
ai_use: disclose
disclosure: { required: true, where: [description, checkbox, commit-trailer], example: "AI: Claude for tests" }
trailers: { assisted_by: required, co_authored_by_ai: banned }
human_only: [review-replies, commit-messages, pr-description, issues]
assignment_required: true
issue_first: true
required_labels: [[triaged], [help wanted, good first issue]]
dco: true
cla: false
signed_commits: true
ui_screenshots_required: true
`

describe('parsePolicy', () => {
  it('parses every field of the shared schema', () => {
    const r = parsePolicy(FULL)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.policy).toEqual({
      version: 1,
      ai_use: 'disclose',
      disclosure: {
        required: true,
        where: ['description', 'checkbox', 'commit-trailer'],
        example: 'AI: Claude for tests'
      },
      trailers: { assisted_by: 'required', co_authored_by_ai: 'banned' },
      human_only: ['review-replies', 'commit-messages', 'pr-description', 'issues'],
      assignment_required: true,
      issue_first: true,
      required_labels: [['triaged'], ['help wanted', 'good first issue']],
      dco: true,
      cla: false,
      signed_commits: true,
      ui_screenshots_required: true
    })
  })

  it('fills defaults for a minimal file', () => {
    const r = parsePolicy('version: 1\n')
    expect(r.errors).toEqual([])
    expect(r.policy?.ai_use).toBe('unspecified')
    expect(r.policy?.disclosure.required).toBe(false)
    expect(r.policy?.trailers).toEqual({ assisted_by: 'unspecified', co_authored_by_ai: 'unspecified' })
    expect(r.policy?.required_labels).toEqual([])
  })

  it('requires version 1', () => {
    expect(parsePolicy('ai_use: banned\n').errors[0]).toMatch(/version is missing/)
    expect(parsePolicy('version: 2\n').errors[0]).toMatch(/Unsupported policy version 2/)
    expect(parsePolicy('version: "1"\n').errors).toEqual([])
  })

  it('ignores unknown fields with a warning', () => {
    const r = parsePolicy('version: 1\nfoo: bar\ndisclosure: { required: false, colour: red }\n')
    expect(r.errors).toEqual([])
    expect(r.warnings).toContain('Unknown field "foo" ignored')
    expect(r.warnings).toContain('Unknown field "disclosure.colour" ignored')
  })

  it('rejects bad enum values and types', () => {
    const r = parsePolicy('version: 1\nai_use: sometimes\ndco: "yes"\ntrailers: { assisted_by: maybe }\n')
    expect(r.policy).toBeNull()
    expect(r.errors).toHaveLength(3)
    expect(r.errors.join('\n')).toMatch(/ai_use must be one of/)
    expect(r.errors.join('\n')).toMatch(/dco must be true or false/)
    expect(r.errors.join('\n')).toMatch(/trailers.assisted_by must be one of/)
  })

  it('reports invalid YAML and non-mapping documents', () => {
    expect(parsePolicy('version: [1\n').errors[0]).toMatch(/Invalid YAML/)
    expect(parsePolicy('- 1\n').errors[0]).toMatch(/mapping/)
  })

  it('warns about unknown disclosure locations and defaults "where" to description', () => {
    const r = parsePolicy('version: 1\ndisclosure: { required: true, where: [slack] }\n')
    expect(r.policy?.disclosure.where).toEqual(['description'])
    expect(r.warnings.join('\n')).toMatch(/Unknown disclosure location "slack"/)
  })

  it('accepts flat required_labels with a warning (each label required)', () => {
    const r = parsePolicy('version: 1\nrequired_labels: [triaged, help wanted]\n')
    expect(r.policy?.required_labels).toEqual([['triaged'], ['help wanted']])
    expect(r.warnings.join('\n')).toMatch(/plain strings/)
  })

  it('rejects malformed required_labels', () => {
    expect(parsePolicy('version: 1\nrequired_labels: triaged\n').policy).toBeNull()
    expect(parsePolicy('version: 1\nrequired_labels: [[1, 2]]\n').policy).toBeNull()
  })

  it('warns about unrecognised human_only values but keeps them', () => {
    const r = parsePolicy('version: 1\nhuman_only: [design-docs]\n')
    expect(r.policy?.human_only).toEqual(['design-docs'])
    expect(r.warnings[0]).toMatch(/design-docs/)
  })

  it('parses every example policy shipped in examples/policies without warnings', () => {
    const dir = join(import.meta.dirname, '..', 'examples', 'policies')
    const files = readdirSync(dir).filter((f) => f.endsWith('.yml'))
    expect(files.length).toBeGreaterThanOrEqual(3)
    for (const f of files) {
      const r = parsePolicy(readFileSync(join(dir, f), 'utf8'))
      expect({ file: f, errors: r.errors, warnings: r.warnings }).toEqual({ file: f, errors: [], warnings: [] })
    }
  })
})
