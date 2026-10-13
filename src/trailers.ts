import { classifyIdentity, parseIdentity } from './identities.js'

export interface Trailer {
  /** Lower-cased key, e.g. "co-authored-by". */
  key: string
  value: string
}

const TRAILER_KEYS = ['assisted-by', 'co-authored-by', 'generated-by', 'signed-off-by']
const TRAILER_LINE = /^[ \t]*([A-Za-z][A-Za-z-]*)[ \t]*:[ \t]*(\S.*?)[ \t]*$/gm

/**
 * Extract the trailers this action cares about from a commit message.
 *
 * Git only treats the last paragraph as trailers, but tools and people put
 * these lines in other places too. Because the keys are specific, any line of
 * the form "Key: value" with a known key is accepted wherever it appears.
 */
export function parseTrailers(message: string): Trailer[] {
  const out: Trailer[] = []
  for (const m of message.matchAll(TRAILER_LINE)) {
    const key = (m[1] ?? '').toLowerCase()
    if (TRAILER_KEYS.includes(key)) out.push({ key, value: m[2] ?? '' })
  }
  return out
}

export interface AiTrailer {
  key: string
  value: string
  /** Tool identified from the value, if any. */
  tool: string | null
}

/**
 * Trailers that state AI involvement:
 * - every `Assisted-by` and `Generated-by` trailer (both exist only to name tools);
 * - `Co-authored-by` only when the identity is a known AI tool.
 */
export function aiTrailers(message: string): AiTrailer[] {
  const result: AiTrailer[] = []
  for (const t of parseTrailers(message)) {
    if (t.key === 'assisted-by' || t.key === 'generated-by') {
      result.push({ ...t, tool: toolFromFreeText(t.value) })
    } else if (t.key === 'co-authored-by') {
      const id = parseIdentity(t.value)
      const tool = classifyIdentity(id.name, id.email)
      if (tool) result.push({ ...t, tool })
    }
  }
  return result
}

/** Signed-off-by identities on a commit. */
export function signOffs(message: string): { name: string; email: string; raw: string }[] {
  return parseTrailers(message)
    .filter((t) => t.key === 'signed-off-by')
    .map((t) => ({ ...parseIdentity(t.value), raw: t.value }))
}

// Assisted-by values look like "Claude:claude-opus-4-1" (kernel/Flux style),
// "GitHub Copilot", or "Claude <noreply@anthropic.com>".
const FREE_TEXT_TOOLS: [RegExp, string][] = [
  [/\bclaude\b/i, 'Claude'],
  [/\bcopilot\b/i, 'GitHub Copilot'],
  [/\bcursor\b/i, 'Cursor'],
  [/\bcodex\b/i, 'OpenAI Codex'],
  [/\bchatgpt\b|\bgpt-?\d/i, 'ChatGPT'],
  [/\bgemini\b/i, 'Gemini'],
  [/\bdevin\b/i, 'Devin'],
  [/\baider\b/i, 'Aider'],
  [/\bopenhands\b/i, 'OpenHands'],
  [/\bjules\b/i, 'Jules'],
  [/\bamazon q\b/i, 'Amazon Q Developer'],
  [/\bwindsurf\b|\bcodeium\b/i, 'Windsurf'],
  [/\btabnine\b/i, 'Tabnine'],
  [/\bcody\b/i, 'Sourcegraph Cody']
]

/** Best-effort tool name from text that is already known to describe an AI tool. */
export function toolFromFreeText(text: string): string | null {
  const id = parseIdentity(text)
  const fromIdentity = classifyIdentity(id.name, id.email)
  if (fromIdentity) return fromIdentity
  for (const [re, tool] of FREE_TEXT_TOOLS) if (re.test(text)) return tool
  return null
}
