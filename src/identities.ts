// Known AI tools, the git identities they write into commits, and the GitHub
// accounts they open pull requests from.
//
// Precision matters more than coverage here: a false match turns a human's
// pull request into an "AI-assisted" one and can produce violations. Names that
// are also common first names (Claude, Devin, Jules, Cody) are therefore only
// matched together with a qualifier or a tool-owned email address.

interface IdentityRule {
  tool: string
  /** Matched against the whole display name, case-insensitively. */
  names?: RegExp[]
  /** Matched against the whole email address, case-insensitively. */
  emails?: RegExp[]
}

const GH_NOREPLY = String.raw`(?:\d+\+)?`
const noreply = (login: string): RegExp =>
  new RegExp(`^${GH_NOREPLY}${login.replace(/[[\]]/g, '\\$&')}@users\\.noreply\\.github\\.com$`, 'i')

const IDENTITY_RULES: IdentityRule[] = [
  {
    tool: 'Claude',
    names: [/^claude[ -](?:code|opus|sonnet|haiku|ai|\d)[\w .:/()-]*$/i, /^anthropic claude\b/i],
    emails: [/^noreply@anthropic\.com$/i, /^claude@anthropic\.com$/i, noreply('claude[bot]')]
  },
  {
    tool: 'GitHub Copilot',
    names: [/^(?:github )?copilot(?:[ -](?:agent|chat|swe-agent|coding agent))?(?:\[bot\])?$/i, /^copilot-swe-agent(?:\[bot\])?$/i],
    emails: [noreply('Copilot'), noreply('copilot-swe-agent[bot]'), /^copilot@github\.com$/i]
  },
  {
    tool: 'Cursor',
    names: [/^cursor[ -]?(?:agent|ai|bot)$/i, /^cursor\[bot\]$/i],
    emails: [/^cursoragent@cursor\.com$/i, noreply('cursor[bot]')]
  },
  {
    tool: 'OpenAI Codex',
    names: [/^(?:openai )?codex(?:[ -](?:cli|agent|bot))?$/i, /^chatgpt-codex-connector(?:\[bot\])?$/i],
    emails: [/^codex@openai\.com$/i, noreply('chatgpt-codex-connector[bot]')]
  },
  {
    tool: 'ChatGPT',
    names: [/^chatgpt\b[\w .:/()-]*$/i, /^gpt-?\d[\w .:/()-]*$/i]
  },
  {
    tool: 'Devin',
    names: [/^devin[ -]ai\b[\w .:/()-]*$/i, /^devin-ai-integration(?:\[bot\])?$/i],
    emails: [noreply('devin-ai-integration[bot]')]
  },
  {
    tool: 'Gemini',
    names: [/^(?:google )?gemini(?:[ -](?:cli|code assist|code-assist|agent|\d)[\w .:/()-]*)?$/i, /^gemini-code-assist(?:\[bot\])?$/i],
    emails: [noreply('gemini-code-assist[bot]')]
  },
  {
    tool: 'Jules',
    names: [/^google[ -]labs[ -]jules(?:\[bot\])?$/i, /^jules[ -](?:bot|agent)$/i],
    emails: [noreply('google-labs-jules[bot]')]
  },
  {
    tool: 'Aider',
    // Aider appends " (aider)" to the author name by default.
    names: [/^aider(?:[ (][\w .:/()-]*)?$/i, /\(aider\)$/i],
    emails: [/^noreply@aider\.chat$/i]
  },
  {
    tool: 'OpenHands',
    names: [/^openhands(?:[ -](?:agent|ai|bot))?$/i],
    emails: [/^openhands@all-hands\.dev$/i]
  },
  {
    tool: 'Amazon Q Developer',
    names: [/^amazon q(?: developer)?$/i, /^amazon-q-developer(?:\[bot\])?$/i],
    emails: [noreply('amazon-q-developer[bot]')]
  },
  { tool: 'Windsurf', names: [/^windsurf(?:[ -](?:agent|ai|cascade))?$/i, /^codeium(?:[ -]bot)?$/i] },
  { tool: 'Tabnine', names: [/^tabnine(?:[ -](?:agent|ai|bot))?$/i] },
  { tool: 'Sourcegraph Cody', names: [/^sourcegraph cody$/i] },
  { tool: 'Sweep', names: [/^sweep-ai(?:\[bot\])?$/i], emails: [noreply('sweep-ai[bot]')] }
]

/**
 * Return the AI tool a git identity ("Name <email>") belongs to, or null for
 * anything that is not clearly an AI tool.
 */
export function classifyIdentity(name: string, email: string): string | null {
  const n = name.trim()
  const e = email.trim()
  for (const rule of IDENTITY_RULES) {
    if (e && rule.emails?.some((re) => re.test(e))) return rule.tool
    if (n && rule.names?.some((re) => re.test(n))) return rule.tool
  }
  return null
}

/** Parse a "Name <email>" trailer value. Email is empty when absent. */
export function parseIdentity(value: string): { name: string; email: string } {
  const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(value.trim())
  if (m) return { name: (m[1] ?? '').trim(), email: (m[2] ?? '').trim() }
  return { name: value.trim(), email: '' }
}

/**
 * GitHub accounts that open pull requests on behalf of an AI agent. Users can
 * extend this list with the `bot-authors` input. It is not exhaustive.
 */
export const DEFAULT_BOT_AUTHORS = [
  'Copilot',
  'copilot-swe-agent[bot]',
  'devin-ai-integration[bot]',
  'google-labs-jules[bot]',
  'chatgpt-codex-connector[bot]',
  'amazon-q-developer[bot]',
  'sweep-ai[bot]',
  'openhands-agent'
]

/** Match a login against patterns that may contain `*` wildcards (case-insensitive). */
export function matchesLogin(login: string, patterns: string[]): string | null {
  for (const p of patterns) {
    const pattern = p.trim()
    if (!pattern) continue
    const re = new RegExp(
      '^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
      'i'
    )
    if (re.test(login)) return pattern
  }
  return null
}

/** Parse the `bot-authors` input: comma- or newline-separated logins. */
export function parseLoginList(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('#'))
}
