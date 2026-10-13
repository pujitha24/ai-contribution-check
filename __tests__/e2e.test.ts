// End-to-end: run the bundled dist/index.js as the runner would, against a
// fixture webhook payload and a local stand-in for the GitHub API.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const fixtures = join(import.meta.dirname, 'fixtures')
const dist = join(root, 'dist', 'index.js')
const BASE_SHA = '9fceb02d0ae598e95dc970b74767f19372d61af8'

interface Recorded {
  method: string
  path: string
  body: string
  auth: string | undefined
}

interface ApiState {
  requests: Recorded[]
  pull: Record<string, unknown>
  commits: unknown
  comments: { id: number; body: string }[]
}

function json(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtures, 'api', name), 'utf8')) as Record<string, unknown>
}

async function readBody(req: IncomingMessage): Promise<string> {
  let data = ''
  for await (const chunk of req) data += String(chunk)
  return data
}

function startApi(state: ApiState): Promise<Server> {
  const policy = readFileSync(join(fixtures, 'ai-policy.yml'))
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = decodeURIComponent(url.pathname)
      const body = await readBody(req)
      state.requests.push({ method: req.method ?? '', path: `${path}${url.search}`, body, auth: req.headers.authorization })
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      const key = `${req.method} ${path}`
      if (key === 'GET /repos/acme/widgets/contents/.github/ai-policy.yml') {
        if (url.searchParams.get('ref') !== BASE_SHA) return send(404, { message: 'Not Found' })
        return send(200, {
          type: 'file',
          name: 'ai-policy.yml',
          path: '.github/ai-policy.yml',
          encoding: 'base64',
          content: policy.toString('base64')
        })
      }
      if (key === 'GET /repos/acme/widgets/pulls/42') return send(200, state.pull)
      if (key === 'GET /repos/acme/widgets/pulls/42/commits') return send(200, state.commits)
      if (key === 'POST /graphql') return send(200, json('graphql-closing-issues.json'))
      if (key === 'GET /repos/acme/widgets/issues/42/comments') return send(200, state.comments)
      if (key === 'POST /repos/acme/widgets/issues/42/comments') {
        const created = { id: 1001, body: (JSON.parse(body) as { body: string }).body }
        state.comments.push(created)
        return send(201, created)
      }
      if (req.method === 'PATCH' && path.startsWith('/repos/acme/widgets/issues/comments/')) {
        const c = state.comments.find((x) => x.id === Number(path.split('/').pop()))
        if (c) c.body = (JSON.parse(body) as { body: string }).body
        return send(200, c)
      }
      return send(404, { message: `Not Found: ${key}` })
    })()
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

interface RunOutput {
  code: number | null
  stdout: string
  outputs: Record<string, string>
  summary: string
}

function parseOutputFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /^([\w-]+)<<(ghadelimiter_[\w-]+)\n([\s\S]*?)\n\2$/gm
  for (const m of text.matchAll(re)) out[m[1] ?? ''] = m[3] ?? ''
  return out
}

async function runAction(server: Server, inputs: Record<string, string>): Promise<RunOutput> {
  const dir = mkdtempSync(join(tmpdir(), 'ai-contribution-check-'))
  const outputFile = join(dir, 'output')
  const summaryFile = join(dir, 'summary')
  writeFileSync(outputFile, '')
  writeFileSync(summaryFile, '')
  const { port } = server.address() as AddressInfo
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'pull_request_target',
    GITHUB_EVENT_PATH: join(fixtures, 'event-pull_request_target.json'),
    GITHUB_REPOSITORY: 'acme/widgets',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    GITHUB_GRAPHQL_URL: `http://127.0.0.1:${port}/graphql`,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    NO_PROXY: '127.0.0.1',
    'INPUT_TOKEN': 'test-token',
    'INPUT_POLICY-FILE': '.github/ai-policy.yml',
    'INPUT_FAIL-ON': 'violation',
    'INPUT_COMMENT': 'false',
    'INPUT_BOT-AUTHORS': ''
  }
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v

  const child = spawn(process.execPath, [dist], { cwd: root, env })
  let stdout = ''
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
  child.stderr.on('data', (d: Buffer) => (stdout += d.toString()))
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
  return {
    code,
    stdout,
    outputs: parseOutputFile(readFileSync(outputFile, 'utf8')),
    summary: readFileSync(summaryFile, 'utf8')
  }
}

describe('bundled action (dist/index.js)', () => {
  const state: ApiState = { requests: [], pull: json('pull.json'), commits: json('commits.json'), comments: [] }
  let server: Server

  beforeAll(async () => {
    if (!existsSync(dist)) throw new Error('dist/index.js is missing: run `npm run build` first')
    server = await startApi(state)
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('reports violations, sets outputs and fails the step', async () => {
    state.requests.length = 0
    const r = await runAction(server, {})

    expect(r.code).toBe(1)
    expect(r.outputs['ai-assisted']).toBe('true')
    expect(r.outputs.violations).toBe('2')
    expect(r.outputs.report).toContain('## AI Contribution Check')
    expect(r.stdout).toContain('::error title=AI policy%3A AI co-author trailer::Commit 1f2e3d4 lists Claude as a co-author')
    expect(r.stdout).toContain('::error title=AI policy%3A Issue labels::Issue #17 is not open to AI-assisted contributions')
    expect(r.stdout).toContain('::error::2 AI contribution policy violation(s)')
    expect(r.summary).toContain('**2 policy violations** found.')
    expect(r.summary).toContain('**Pass** · AI disclosure: Disclosed in the PR description.')
    expect(r.summary).toContain('**Pass** · DCO sign-off')

    // Read-only, authenticated, policy read from the base commit.
    expect(state.requests.every((q) => q.method === 'GET' || q.path === '/graphql')).toBe(true)
    expect(state.requests.every((q) => q.auth === 'token test-token')).toBe(true)
    expect(state.requests[0]?.path).toBe(`/repos/acme/widgets/contents/.github/ai-policy.yml?ref=${BASE_SHA}`)
  })

  it('notice-only mode with a sticky comment', async () => {
    state.requests.length = 0
    const first = await runAction(server, { 'fail-on': 'never', comment: 'true' })
    expect(first.code).toBe(0)
    expect(state.comments).toHaveLength(1)
    expect(state.comments[0]?.body).toMatch(/^<!-- ai-contribution-check:sticky -->\n## AI Contribution Check/)

    const second = await runAction(server, { 'fail-on': 'never', comment: 'true' })
    expect(second.code).toBe(0)
    expect(state.comments).toHaveLength(1)
    expect(state.requests.filter((q) => q.method === 'PATCH')).toHaveLength(1)
  })

  it('flags an undisclosed AI co-author trailer', async () => {
    state.pull = { ...json('pull.json'), body: 'Fixes #17\n\nAdds exponential backoff to the uploader.' }
    const r = await runAction(server, { 'fail-on': 'never' })
    expect(r.code).toBe(0)
    expect(r.outputs['ai-assisted']).toBe('true')
    expect(r.outputs.violations).toBe('3')
    expect(r.summary).toContain('AI disclosure: AI assistance is indicated (commit 1f2e3d4: Co-authored-by trailer (Claude))')
  })

  it('leaves a human pull request alone apart from a neutral notice', async () => {
    const commits = json('commits.json') as unknown as { commit: { message: string } }[]
    for (const c of commits) c.commit.message = c.commit.message.replace(/^Co-Authored-By:.*\n/m, '')
    state.commits = commits
    state.pull = { ...json('pull.json'), body: 'Fixes #17\n\nAdds exponential backoff to the uploader.' }
    const r = await runAction(server, {})
    expect(r.code).toBe(0)
    expect(r.outputs).toMatchObject({ 'ai-assisted': 'false', violations: '0' })
    expect(r.stdout).toContain('::notice title=AI policy%3A AI disclosure::No AI-assistance disclosure found.')
    expect(r.stdout).not.toContain('::error')
    expect(r.summary).toContain('**No AI assistance detected.**')
  })
})
