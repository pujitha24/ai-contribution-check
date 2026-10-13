import * as core from '@actions/core'
import * as github from '@actions/github'
import { createClient } from './github.js'
import { parseInputs, runCheck, type Io, type RunContext } from './main.js'

const io: Io = {
  setOutput: (name, value) => core.setOutput(name, value),
  info: (message) => core.info(message),
  notice: (message, title) => core.notice(message, title ? { title } : {}),
  warning: (message, title) => core.warning(message, title ? { title } : {}),
  error: (message, title) => core.error(message, title ? { title } : {}),
  setFailed: (message) => core.setFailed(message),
  writeSummary: async (markdown) => {
    if (!process.env.GITHUB_STEP_SUMMARY) return
    await core.summary.addRaw(markdown).write()
  }
}

async function main(): Promise<void> {
  try {
    const inputs = parseInputs((name) => core.getInput(name))
    const token = core.getInput('token', { required: true })
    const { context } = github
    const pr = context.payload.pull_request as { number?: number; base?: { sha?: string } } | undefined
    const ctx: RunContext = {
      eventName: context.eventName,
      owner: context.repo.owner,
      repo: context.repo.repo,
      pullNumber: typeof pr?.number === 'number' ? pr.number : null,
      baseSha: pr?.base?.sha ?? null,
      serverUrl: context.serverUrl
    }
    const client = createClient(github.getOctokit(token), ctx.owner, ctx.repo)
    await runCheck(ctx, inputs, client, io)
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}

void main()
