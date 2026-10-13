// Detection of AI assistance from what a contributor wrote.
//
// The detectors look for what the contributor *said* (a disclosure, a ticked
// checkbox, a trailer, a tool's own git identity). They cannot tell whether
// code was written with AI when nobody said so, and they are deliberately
// conservative: a sentence about an AI feature is not a disclosure.

import { classifyIdentity, matchesLogin } from './identities.js'
import { aiTrailers, toolFromFreeText } from './trailers.js'
import { ci, clauses, excerpt, stripNonProse, unlink } from './text.js'
import type { CommitInfo, Detection, Signal } from './types.js'

// ---------------------------------------------------------------------------
// Vocabulary
//
// Regexes are built without the `i` flag: `ci()` makes the parts that should
// ignore case case-insensitive, so "AI" (and "Cursor") can stay case-sensitive.

const SUFFIX = ci(
  `(?:[ -](?:tools?|assistants?|agents?|models?|chat|cli|coding assistants?|coding agents?|coding tools?|code|agent mode))*`
)

// "AI" is case-sensitive so that "ai" in other languages or identifiers does
// not count; the other generic terms ignore case.
const GENERIC_AI = ['AI', 'A\\.I\\.', ci('genai|gen ai|llms?|generative ai|artificial intelligence|(?:large )?language models?')]

// Names that are also common first names (Devin, Jules, Cody) need a
// qualifier; "Cursor" must be capitalised, since "cursor" is a database term.
const TOOL_NAMES = [
  ci('claude(?:[ -]code)?'),
  ci('(?:github )?copilot'),
  ci('chatgpt'),
  ci('gpt-?\\d[\\w.]*'),
  ci('(?:openai )?codex'),
  ci('(?:google )?gemini'),
  ci('aider|openhands|windsurf|codeium|tabnine|amazon q|devin[ -]ai|google jules|sourcegraph cody'),
  'Cursor'
]

const MENTION = `(?<![\\w-])(?:${[...GENERIC_AI, ...TOOL_NAMES].join('|')})${SUFFIX}(?![\\w])`
const MENTION_RE = new RegExp(MENTION)

const PARTICIPLES =
  'generated|written|authored|created|produced|drafted|assisted|aided|co-?written|co-?authored|' +
  'implemented|developed|refactored|prepared|composed|coded|made|done|helped|built|translated|edited'

const ARTICLE = ci(String.raw`(?:(?:an?|the|some|several)\s+)?`)

interface Cue {
  re: RegExp
  /**
   * When the cue opens the clause, does it count without a self-reference?
   * "Generated with Claude Code" does; "Using an LLM, the tool now ..." does
   * not. "short" allows it only when little else follows ("AI-assisted.").
   */
  atStart: boolean | 'short'
}

/** Patterns that tie a mention to the act of producing this contribution. */
const CUES: Cue[] = [
  // "AI-assisted", "LLM generated", "Claude-written"
  { re: new RegExp(MENTION + ci(`[ -](?:${PARTICIPLES})\\b`)), atStart: 'short' },
  // "written with Claude Code", "generated in part by an LLM", "drafted with the help of Copilot"
  {
    re: new RegExp(
      ci(
        `\\b(?:${PARTICIPLES})\\b(?:\\s+[\\w'’-]+){0,3}?\\s+(?:with|by|using|via|through|from)\\s+` +
          `(?:the\\s+)?(?:(?:help|assistance|support)\\s+(?:of|from)\\s+)?`
      ) +
        ARTICLE +
        MENTION
    ),
    atStart: true
  },
  // "I used Copilot", "with help from ChatGPT", "assisted by Gemini"
  {
    re: new RegExp(
      ci(
        `\\b(?:used|leveraged|employed|relied on|consulted|asked|prompted|` +
          `with (?:the )?(?:help|assistance|support) (?:of|from)|(?:assisted|aided|helped) by)\\s+`
      ) +
        ARTICLE +
        MENTION
    ),
    atStart: true
  },
  // "Using Claude Code to draft the tests."
  { re: new RegExp(`^[\\W_]*${ci('using')}\\s+` + ARTICLE + MENTION), atStart: false },
  // "AI was used for ...", "Copilot was consulted"
  {
    re: new RegExp(MENTION + ci(`\\s+(?:was|were|has been|have been)\\s+(?:used|consulted|involved)\\b`)),
    atStart: true
  },
  // "Copilot suggested ...", "Claude wrote the tests"
  {
    re: new RegExp(
      MENTION + ci(`\\s+(?:helped|assisted|wrote|generated|drafted|suggested|produced|authored|created)\\b`)
    ),
    atStart: false
  }
]

/** Self-references that make a sentence about *this* contribution. */
const ANCHOR_SOURCE =
  `\\b(?:I|I'm|I’m|I've|I’ve|I'd|I’d)(?![\\w'’])|` +
  ci(
    `\\b(?:me|my|we|we've|we’ve|we're|we’re|our|us)\\b|` +
      `\\bthis\\s+(?:pr|pull request|change|patch|commit|code|fix|implementation|description|diff|refactor|contribution|work|branch|test|document)|` +
      `\\b(?:these|the)\\s+(?:changes|commits|code|patch|tests?|implementation|description|docs|documentation|commit message|pr|pull request|fix|refactor)\\b|` +
      `\\b(?:parts?|portions?|some|most|all|much|half)\\s+of\\b`
  )
const ANCHOR = new RegExp(ANCHOR_SOURCE)
// Negative statements are often impersonal: "No AI tools were used.", "Written without AI."
const ANCHOR_OR_IMPERSONAL = new RegExp(
  `${ANCHOR_SOURCE}|^[\\W_]*${ci(`(?:no|not|without|none|${PARTICIPLES})`)}\\b`
)

const NEGATION =
  /\b(?:no|not|never|without|none|nothing|neither|nor|zero|n\/a|didn['’]?t|don['’]?t|doesn['’]?t|wasn['’]?t|weren['’]?t|haven['’]?t|hasn['’]?t|isn['’]?t|aren['’]?t)\b/i

/** Words that make a negated mention a statement about use ("No AI was used"). */
const USAGE_WORD =
  /\b(?:use|used|uses|using|usage|assist|assisted|assistance|generated|generate|written|tools?|involved|help|helped|created|authored)\b/i

// Context that describes software behaviour, not authorship:
// "fixes a crash when using Copilot", "adds support for using an LLM".
const BEHAVIOUR_CONTEXT = /\b(?:when|while|if|for|before|after|by|of|on|about|whether|without)\s+$/i

// Checkbox text that acknowledges a policy rather than declaring use:
// "[x] I understand I am responsible for AI-generated code".
const ACKNOWLEDGEMENT = /\b(?:understand|agree|acknowledge|have read|read the|responsible|accountable|policy|guidelines?)\b/i
const FIRST_PERSON_USE = /\b(?:I|we)\s+(?:have\s+)?(?:used|use)\b/i

// ---------------------------------------------------------------------------
// Description detectors

const CHECKBOX_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+)$/
const TRAILER_LIKE_LINE = /^\s*(assisted-by|generated-by|co-authored-by)\s*:\s*(\S.*)$/i
const LABEL_LINE = new RegExp(
  String.raw`^\s*(?:[#>*_\-]+\s*)*(?:\*\*|__)?\s*` +
    `(?:AI|LLM|GenAI|Generative AI|${ci('ai')})` +
    ci(
      `(?:[ -](?:usage|use|used|disclosure|assistance|assisted|tools?(?: used)?|involvement|generated|statement|declaration))?`
    ) +
    String.raw`\s*\??\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.*)$`
)
const QUESTION_LINE = new RegExp(
  String.raw`^\s*(?:[#>*_\-]+\s*)*(?:\*\*|__)?\s*` +
    ci(`(?:did you use|was|were|have you used|did this pr use)\\s+(?:any\\s+)?`) +
    `(?:AI|LLM|${ci('generative ai')})` +
    ci(`(?:\\s+tools?)?(?:\\s+used)?`) +
    String.raw`\s*\?\s*(?:\*\*|__)?\s*[:：]?\s*(?:\*\*|__)?\s*(.*)$`
)

const BARE_LABEL = new RegExp(
  String.raw`^\s*(?:[#>*_\-]+\s*)*(?:\*\*|__)?\s*(?:AI|LLM|GenAI|Generative AI|${ci('ai')})\s*\??\s*(?:\*\*|__)?\s*[:：]`
)
const AFFIRMATIVE_ANSWER = /^(?:yes|y|true)\b|\b(?:used|using|assisted|generated|drafted|written)\b/i

const PLACEHOLDER =
  /^(?:\[.*\]|<.*>|\(.*\)|_+|\.{3}|…|tbd|todo|yes\s*\/\s*no|y\s*\/\s*n|see (?:below|above)|below|above)$/i
const NEGATIVE_ANSWER =
  /^(?:no|none|n\/?a|nope|not used|not applicable|false|0|-|–|—|nothing|zero|nil)(?![\w])/i

function classifyStatement(clause: string): { polarity: 'positive' | 'negative'; mention: string } | null {
  const mention = MENTION_RE.exec(clause)
  if (!mention) return null
  const negated = NEGATION.test(clause)
  for (const cue of CUES) {
    const m = cue.re.exec(clause)
    if (!m) continue
    const before = clause.slice(0, m.index)
    if (BEHAVIOUR_CONTEXT.test(before)) continue
    const after = clause.slice(m.index + m[0].length)
    const opensClause = /^[\W_]*$/u.test(before)
    const startOk =
      opensClause && (cue.atStart === true || (cue.atStart === 'short' && after.trim().split(/\s+/).length <= 3))
    if (!startOk && !ANCHOR.test(clause)) continue
    return { polarity: negated ? 'negative' : 'positive', mention: MENTION_RE.exec(m[0])?.[0] ?? mention[0] }
  }
  if (negated && USAGE_WORD.test(clause) && ANCHOR_OR_IMPERSONAL.test(clause)) {
    return { polarity: 'negative', mention: mention[0] }
  }
  return null
}

function toolOf(text: string): string {
  return toolFromFreeText(text) ?? 'AI (unspecified tool)'
}

/** Find disclosure signals (positive and negative) in a PR description. */
export function detectInDescription(body: string): Signal[] {
  const signals: Signal[] = []
  const location = 'PR description'
  const lines = stripNonProse(body).split('\n')

  for (const rawLine of lines) {
    const line = unlink(rawLine)
    if (!line.trim()) continue
    // Quoted text is usually someone else's words (an issue, a review).
    if (/^\s*>/.test(line)) continue

    const box = CHECKBOX_LINE.exec(line)
    if (box) {
      const ticked = (box[1] ?? ' ').toLowerCase() === 'x'
      const text = box[2] ?? ''
      if (!ticked || !MENTION_RE.test(text)) continue
      const negated = NEGATION.test(text)
      // A ticked "I have read the AI policy" box says nothing about use.
      if (!negated && ACKNOWLEDGEMENT.test(text) && !FIRST_PERSON_USE.test(text)) continue
      const hasCue = CUES.some((c) => c.re.test(text)) || USAGE_WORD.test(text)
      if (!hasCue) continue
      signals.push({
        kind: 'checkbox',
        polarity: negated ? 'negative' : 'positive',
        location,
        evidence: excerpt(`[x] ${text}`),
        tool: toolOf(text)
      })
      continue
    }

    const trailer = TRAILER_LIKE_LINE.exec(line)
    if (trailer) {
      const key = (trailer[1] ?? '').toLowerCase()
      const value = trailer[2] ?? ''
      const ai = aiTrailers(`${key}: ${value}`)
      if (ai.length > 0) {
        signals.push({
          kind: 'description-trailer',
          polarity: 'positive',
          location,
          evidence: excerpt(line.trim()),
          tool: ai[0]?.tool ?? toolOf(value),
          trailerKey: key
        })
      }
      continue
    }

    const label = LABEL_LINE.exec(line) ?? QUESTION_LINE.exec(line)
    if (label) {
      const answer = (label[1] ?? '').replace(/[*_]+/g, '').trim()
      if (!answer || PLACEHOLDER.test(answer)) continue
      const negative = NEGATIVE_ANSWER.test(answer)
      // A bare "AI:" label is also used for notes about AI features; only a
      // clear answer counts there.
      if (!negative && BARE_LABEL.test(line) && !AFFIRMATIVE_ANSWER.test(answer) && !MENTION_RE.test(answer)) continue
      signals.push({
        kind: 'description-statement',
        polarity: negative ? 'negative' : 'positive',
        location,
        evidence: excerpt(line.trim()),
        tool: toolOf(answer)
      })
      continue
    }

    for (const clause of clauses(line)) {
      const s = classifyStatement(clause)
      if (!s) continue
      signals.push({
        kind: 'description-statement',
        polarity: s.polarity,
        location,
        evidence: excerpt(clause),
        tool: toolOf(s.mention)
      })
    }
  }
  return signals
}

// ---------------------------------------------------------------------------
// Commit detectors

// Lines such as "Generated with [Claude Code](https://claude.com/claude-code)".
const ATTRIBUTION_LINE = new RegExp(
  '^[\\W_]*' +
    ci('(?:generated|created|written|authored|made|built|co-authored)\\s+(?:with|by|using)\\s+') +
    `\\[?(${TOOL_NAMES.join('|')})(?![\\w])`,
  'm'
)

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** Find AI signals in one commit: trailers, tool attribution lines, tool identities. */
export function detectInCommit(commit: CommitInfo, botAuthors: string[]): Signal[] {
  const location = `commit ${shortSha(commit.sha)}`
  const signals: Signal[] = []

  for (const t of aiTrailers(commit.message)) {
    signals.push({
      kind: 'commit-trailer',
      polarity: 'positive',
      location,
      evidence: excerpt(`${canonicalKey(t.key)}: ${t.value}`),
      tool: t.tool ?? 'AI (unspecified tool)',
      trailerKey: t.key
    })
  }

  const attribution = ATTRIBUTION_LINE.exec(commit.message)
  if (attribution) {
    const line = commit.message.slice(attribution.index).split('\n')[0] ?? ''
    signals.push({
      kind: 'commit-attribution',
      polarity: 'positive',
      location,
      evidence: excerpt(unlink(line)),
      tool: toolOf(attribution[1] ?? '')
    })
  }

  const authorTool =
    classifyIdentity(commit.authorName, commit.authorEmail) ??
    classifyIdentity(commit.committerName, commit.committerEmail)
  const botLogin = commit.authorLogin ? matchesLogin(commit.authorLogin, botAuthors) : null
  if (authorTool || botLogin) {
    signals.push({
      kind: 'commit-author',
      polarity: 'positive',
      location,
      evidence: excerpt(
        botLogin && commit.authorLogin
          ? `author @${commit.authorLogin}`
          : `author ${commit.authorName} <${commit.authorEmail}>`
      ),
      tool: authorTool ?? 'AI agent account'
    })
  }
  return signals
}

export function canonicalKey(key: string): string {
  return key
    .split('-')
    .map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join('-')
}

// ---------------------------------------------------------------------------

export interface DetectInput {
  body: string
  authorLogin: string
  commits: CommitInfo[]
  botAuthors: string[]
}

export function detectAiAssistance(input: DetectInput): Detection {
  const signals: Signal[] = [...detectInDescription(input.body)]
  const bot = matchesLogin(input.authorLogin, input.botAuthors)
  if (bot) {
    signals.push({
      kind: 'bot-author',
      polarity: 'positive',
      location: 'PR author',
      evidence: `@${input.authorLogin}`,
      tool: 'AI agent account'
    })
  }
  for (const c of input.commits) signals.push(...detectInCommit(c, input.botAuthors))

  const positive = signals.filter((s) => s.polarity === 'positive')
  const negative = signals.filter((s) => s.polarity === 'negative')
  return { aiAssisted: positive.length > 0, positive, negative }
}
