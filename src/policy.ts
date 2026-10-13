import { parse as parseYaml } from 'yaml'
import type {
  AiUse,
  AssistedByRule,
  CoAuthoredByAiRule,
  DisclosureLocation,
  Policy
} from './types.js'

// The schema is shared with the `contribpolicy` CLI, which can generate this
// file. Field names must stay exactly as they are.

const AI_USE: readonly AiUse[] = ['allowed', 'disclose', 'restricted', 'banned', 'unspecified']
const LOCATIONS: readonly DisclosureLocation[] = ['description', 'checkbox', 'commit-trailer']
const ASSISTED_BY: readonly AssistedByRule[] = ['required', 'allowed', 'banned', 'unspecified']
const CO_AUTHORED_BY_AI: readonly CoAuthoredByAiRule[] = ['allowed', 'banned', 'unspecified']
export const KNOWN_HUMAN_ONLY = ['review-replies', 'commit-messages', 'pr-description', 'issues']

const TOP_LEVEL_KEYS = [
  'version',
  'ai_use',
  'disclosure',
  'trailers',
  'human_only',
  'assignment_required',
  'issue_first',
  'required_labels',
  'dco',
  'cla',
  'signed_commits',
  'ui_screenshots_required'
]

export interface PolicyParseResult {
  policy: Policy | null
  errors: string[]
  warnings: string[]
}

export function defaultPolicy(): Policy {
  return {
    version: 1,
    ai_use: 'unspecified',
    disclosure: { required: false, where: [], example: null },
    trailers: { assisted_by: 'unspecified', co_authored_by_ai: 'unspecified' },
    human_only: [],
    assignment_required: false,
    issue_first: false,
    required_labels: [],
    dco: false,
    cla: false,
    signed_commits: false,
    ui_screenshots_required: false
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  errors: string[]
): T | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T
  }
  errors.push(`${field} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`)
  return undefined
}

function bool(value: unknown, field: string, errors: string[]): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  errors.push(`${field} must be true or false (got ${JSON.stringify(value)})`)
  return undefined
}

function stringList(value: unknown, field: string, errors: string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    errors.push(`${field} must be a list of strings`)
    return undefined
  }
  return value.map((v) => v.trim()).filter((v) => v.length > 0)
}

function warnUnknownKeys(
  obj: Record<string, unknown>,
  known: string[],
  prefix: string,
  warnings: string[]
): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) warnings.push(`Unknown field "${prefix}${key}" ignored`)
  }
}

/**
 * Parse and validate the text of `.github/ai-policy.yml`.
 * Unknown fields produce warnings; type errors and a wrong version produce errors.
 */
export function parsePolicy(text: string): PolicyParseResult {
  const errors: string[] = []
  const warnings: string[] = []

  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    return { policy: null, errors: [`Invalid YAML: ${(err as Error).message}`], warnings }
  }
  if (!isRecord(raw)) {
    return { policy: null, errors: ['Policy file must be a YAML mapping'], warnings }
  }

  if (raw.version === undefined) {
    errors.push('version is missing (expected: version: 1)')
  } else if (raw.version !== 1 && raw.version !== '1') {
    errors.push(`Unsupported policy version ${JSON.stringify(raw.version)} (this action supports version 1)`)
  }

  warnUnknownKeys(raw, TOP_LEVEL_KEYS, '', warnings)
  const policy = defaultPolicy()

  policy.ai_use = oneOf(raw.ai_use, AI_USE, 'ai_use', errors) ?? policy.ai_use

  if (raw.disclosure !== undefined && raw.disclosure !== null) {
    if (!isRecord(raw.disclosure)) {
      errors.push('disclosure must be a mapping')
    } else {
      const d = raw.disclosure
      warnUnknownKeys(d, ['required', 'where', 'example'], 'disclosure.', warnings)
      policy.disclosure.required = bool(d.required, 'disclosure.required', errors) ?? false
      const where = stringList(d.where, 'disclosure.where', errors)
      if (where) {
        for (const w of where) {
          if ((LOCATIONS as readonly string[]).includes(w)) {
            if (!policy.disclosure.where.includes(w as DisclosureLocation)) {
              policy.disclosure.where.push(w as DisclosureLocation)
            }
          } else {
            warnings.push(`Unknown disclosure location "${w}" ignored (known: ${LOCATIONS.join(', ')})`)
          }
        }
      }
      if (d.example !== undefined && d.example !== null) {
        if (typeof d.example === 'string') policy.disclosure.example = d.example.trim() || null
        else errors.push('disclosure.example must be a string')
      }
    }
  }
  if (policy.disclosure.required && policy.disclosure.where.length === 0) {
    // Required but no location given: the description is the only place every PR has.
    policy.disclosure.where = ['description']
    warnings.push('disclosure.required is true but disclosure.where is empty; assuming "description"')
  }

  if (raw.trailers !== undefined && raw.trailers !== null) {
    if (!isRecord(raw.trailers)) {
      errors.push('trailers must be a mapping')
    } else {
      const t = raw.trailers
      warnUnknownKeys(t, ['assisted_by', 'co_authored_by_ai'], 'trailers.', warnings)
      policy.trailers.assisted_by =
        oneOf(t.assisted_by, ASSISTED_BY, 'trailers.assisted_by', errors) ?? 'unspecified'
      policy.trailers.co_authored_by_ai =
        oneOf(t.co_authored_by_ai, CO_AUTHORED_BY_AI, 'trailers.co_authored_by_ai', errors) ??
        'unspecified'
    }
  }

  const humanOnly = stringList(raw.human_only, 'human_only', errors)
  if (humanOnly) {
    for (const h of humanOnly) {
      if (!KNOWN_HUMAN_ONLY.includes(h)) {
        warnings.push(`Unrecognised human_only value "${h}" (shown in the summary as-is)`)
      }
    }
    policy.human_only = humanOnly
  }

  policy.assignment_required = bool(raw.assignment_required, 'assignment_required', errors) ?? false
  policy.issue_first = bool(raw.issue_first, 'issue_first', errors) ?? false
  policy.dco = bool(raw.dco, 'dco', errors) ?? false
  policy.cla = bool(raw.cla, 'cla', errors) ?? false
  policy.signed_commits = bool(raw.signed_commits, 'signed_commits', errors) ?? false
  policy.ui_screenshots_required =
    bool(raw.ui_screenshots_required, 'ui_screenshots_required', errors) ?? false

  if (raw.required_labels !== undefined && raw.required_labels !== null) {
    policy.required_labels = parseLabelGroups(raw.required_labels, errors, warnings)
  }

  if (policy.trailers.assisted_by === 'banned' && policy.disclosure.where.includes('commit-trailer')) {
    warnings.push(
      'trailers.assisted_by is banned but disclosure.where includes commit-trailer; ' +
        'only Generated-by or allowed Co-authored-by trailers can satisfy commit-trailer disclosure'
    )
  }

  if (errors.length > 0) return { policy: null, errors, warnings }
  return { policy, errors, warnings }
}

function parseLabelGroups(value: unknown, errors: string[], warnings: string[]): string[][] {
  if (!Array.isArray(value)) {
    errors.push('required_labels must be a list of label groups, e.g. [[triaged], [help wanted, good first issue]]')
    return []
  }
  const groups: string[][] = []
  let flattened = false
  for (const entry of value) {
    if (typeof entry === 'string') {
      flattened = true
      if (entry.trim()) groups.push([entry.trim()])
    } else if (Array.isArray(entry) && entry.every((l) => typeof l === 'string')) {
      const group = entry.map((l) => l.trim()).filter((l) => l.length > 0)
      if (group.length > 0) groups.push(group)
    } else {
      errors.push('required_labels entries must be lists of label names')
      return []
    }
  }
  if (flattened) {
    warnings.push(
      'required_labels contains plain strings; each one is treated as a required label on its own ' +
        '(write [[a], [b, c]] for "a AND (b OR c)")'
    )
  }
  return groups
}
