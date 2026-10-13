// Small text helpers shared by the detectors.

/**
 * Remove the parts of a Markdown document that are not the author's own prose:
 * HTML comments (where templates keep their instructions), fenced code blocks
 * and inline code.
 */
export function stripNonProse(markdown: string): string {
  const withoutComments = markdown.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
  const lines = withoutComments.split('\n')
  const kept: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (m?.[1] && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null
      kept.push('')
      continue
    }
    if (m?.[1]) {
      fence = m[1]
      kept.push('')
      continue
    }
    kept.push(line.replace(/`[^`\n]*`/g, ' '))
  }
  return kept.join('\n')
}

/** Turn `[text](url)` into `text` and drop images, so prose reads naturally. */
export function unlink(text: string): string {
  return text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
}

/** Collapse whitespace and truncate for display. */
export function excerpt(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat
}

/** Split prose into clauses: sentences, semicolon parts, and "but"/"however" turns. */
export function clauses(line: string): string[] {
  return line
    .split(/(?<=[.!?;])\s+|,?\s+(?:but|however|although|though|whereas)\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Make regex source case-insensitive without the `i` flag, so it can be
 * combined with parts that must stay case-sensitive (such as "AI").
 * Escapes (\b, \s, ...) and character classes are copied unchanged.
 */
export function ci(source: string): string {
  let out = ''
  for (let i = 0; i < source.length; i++) {
    const c = source.charAt(i)
    if (c === '\\') {
      out += c + source.charAt(i + 1)
      i++
    } else if (c === '[') {
      let j = i + 1
      while (j < source.length && source.charAt(j) !== ']') j += source.charAt(j) === '\\' ? 2 : 1
      out += source.slice(i, j + 1)
      i = j
    } else if (/[a-z]/i.test(c)) {
      out += `[${c.toLowerCase()}${c.toUpperCase()}]`
    } else {
      out += c
    }
  }
  return out
}

/** True if the description contains an image, video or uploaded attachment. */
export function hasImage(markdown: string): boolean {
  const body = markdown.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
  return (
    /!\[[^\]]*\]\([^)\s]+[^)]*\)/.test(body) ||
    /<(?:img|video)\b[^>]*\bsrc=/i.test(body) ||
    /https:\/\/(?:github\.com\/user-attachments\/assets|user-images\.githubusercontent\.com|private-user-images\.githubusercontent\.com)\//i.test(body)
  )
}

/**
 * Render untrusted text as inline code: GitHub does not turn @mentions,
 * #references or HTML inside code spans into anything active.
 */
export function code(text: string): string {
  const flat = text.replace(/\s+/g, ' ').replace(/`/g, "'").trim()
  return '`' + (flat || ' ') + '`'
}
