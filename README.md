# AI Contribution Check

A GitHub Action for maintainers. It reads a small policy file in your repository, `.github/ai-policy.yml`, and checks each pull request against it: AI disclosure, `Assisted-by` and AI `Co-authored-by` trailers, DCO sign-off, signed commits, and rules for the linked issue (labels, assignment).

Results go to the job summary and to annotations. The step can also fail. By default the Action posts no comments. With `comment: true` it keeps one comment on the pull request and updates it on each run.

## Why

Many open-source projects now publish rules for AI-assisted pull requests, and they differ:

- **Disclose, no AI trailers.** Some projects, Kubernetes and Thanos among them, ask contributors to disclose AI use and do not allow AI co-author or `Assisted-by` trailers.
- **`Assisted-by` required.** Others, such as Flux and Tekton, want an `Assisted-by: AGENT:MODEL` trailer on the commits.
- **Label-gated issues.** Some limit automated contributors to certain issues. For example, radius-project/radius only accepts them on issues labelled `triaged` and also `help wanted` or `good first issue`.
- **Process rules.** Others ask for assignment before a pull request, DCO sign-off, or signed commits.

Maintainers usually check these by hand. This Action does the mechanical part, so reviewers can spend their time on the code.

## Quick start

1. Add `.github/ai-policy.yml` to your default branch:

   ```yaml
   version: 1
   ai_use: disclose
   disclosure:
     required: true
     where: [description]
   trailers:
     assisted_by: allowed
     co_authored_by_ai: banned
   ```

2. Add a workflow, for example `.github/workflows/ai-policy.yml`:

   ```yaml
   name: AI policy
   on:
     pull_request_target:
       types: [opened, edited, synchronize, reopened]

   permissions:
     contents: read        # read .github/ai-policy.yml
     pull-requests: read   # read the PR and its commits
     issues: read          # read linked issues

   jobs:
     check:
       runs-on: ubuntu-latest
       steps:
         # No actions/checkout: the Action reads metadata through the API only.
         - uses: pujitha24/ai-contribution-check@v0.1.0  # pin to a full commit SHA in production
   ```

The `edited` event type re-runs the check when the contributor edits the pull request description, for example to add a disclosure.

## Example workflows

### Enforcement (fail the check on violations)

This is the quick-start workflow above. `fail-on` defaults to `violation`. Make the job a required status check if violations should block merging.

### Notice-only mode

Report only. Violations still appear as annotations and in the job summary, but the step does not fail.

```yaml
      - uses: pujitha24/ai-contribution-check@v0.1.0
        id: ai
        with:
          fail-on: never
      - name: Use the result
        if: steps.ai.outputs.violations != '0'
        env:
          VIOLATIONS: ${{ steps.ai.outputs.violations }}
        run: echo "AI policy violations: $VIOLATIONS"
```

### Sticky comment mode

Posts one comment and updates it on every run. A new comment is created only when there is a violation or a check that could not be completed. Clean pull requests get no comment, and neither do human pull requests that only produce the neutral "no disclosure found" notice. If an earlier comment exists, it is updated to show the current state, even once everything passes.

```yaml
on:
  pull_request_target:
    types: [opened, edited, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write   # to post and update the comment
  issues: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: pujitha24/ai-contribution-check@v0.1.0
        with:
          comment: true
          fail-on: never
```

## Example policies

The `examples/policies/` directory has three policies. They are modeled on the projects named, but read your own project's written policy before copying one.

**Kubernetes-style:** disclose in the description; no AI trailers; humans write review replies.

```yaml
version: 1
ai_use: disclose
disclosure:
  required: true
  where: [description]
  example: "AI disclosure: I used <tool> to draft parts of this change and reviewed every line."
trailers:
  assisted_by: banned
  co_authored_by_ai: banned
human_only: [review-replies]
```

**Flux-style:** an `Assisted-by` trailer on every commit of an AI-assisted pull request, plus DCO.

```yaml
version: 1
ai_use: disclose
disclosure:
  required: true
  where: [commit-trailer]
  example: "Assisted-by: Claude:claude-opus-4-1"
trailers:
  assisted_by: required
  co_authored_by_ai: unspecified
dco: true
```

**Radius-style:** AI-assisted and automated contributions only on issues labelled `triaged` AND (`help wanted` OR `good first issue`).

```yaml
version: 1
ai_use: restricted
disclosure:
  required: true
  where: [description, checkbox]
issue_first: true
required_labels:
  - [triaged]
  - [help wanted, good first issue]
```

## Configuration reference

### Inputs

| Input | Default | Description |
|---|---|---|
| `policy-file` | `.github/ai-policy.yml` | Path of the policy in the base repository. It is read from the pull request's **base commit**, so a pull request cannot change the rules it is checked against. |
| `fail-on` | `violation` | `violation` fails the step when any rule is violated. `never` only reports. An invalid policy file also fails the step under `violation`. |
| `comment` | `false` | `true` keeps one comment on the pull request, as described in [Sticky comment mode](#sticky-comment-mode). Needs `pull-requests: write`. |
| `bot-authors` | (empty) | Extra GitHub logins, comma- or newline-separated, `*` wildcards allowed. Pull requests and commits from these accounts count as AI-assisted. They are added to a built-in list of AI agent accounts: `Copilot`, `copilot-swe-agent[bot]`, `devin-ai-integration[bot]`, `google-labs-jules[bot]`, `chatgpt-codex-connector[bot]`, `amazon-q-developer[bot]`, `sweep-ai[bot]` and `openhands-agent`. |
| `token` | `${{ github.token }}` | Token for the API calls. |

### Outputs

| Output | Description |
|---|---|
| `ai-assisted` | `true` or `false`. |
| `violations` | Number of violations. Each listed finding counts, so two commits without sign-off count as 2. |
| `report` | The Markdown report. It contains text from the pull request, so treat it as untrusted (see [Security](#security)). |

`ai-assisted` and `violations` are not set when the policy file is missing or invalid, because nothing was checked.

### Policy file (`version: 1`)

The schema is shared with `contribpolicy`, a sibling command-line tool that can generate this file. Unknown fields are ignored with a warning. Type errors, unknown enum values and any `version` other than `1` are errors.

| Field | Values | Meaning in this Action |
|---|---|---|
| `version` | `1` | Required. |
| `ai_use` | `allowed`, `disclose`, `restricted`, `banned`, `unspecified` | `banned`: a pull request that indicates AI assistance is a violation. `restricted`: a notice; use the other fields to state the restrictions. The other values add no check. |
| `disclosure.required` | `true`/`false` | When AI assistance is indicated, a disclosure must be present in one of `where`. When nothing indicates AI, the check shows a neutral notice and never a violation. |
| `disclosure.where` | list of `description`, `checkbox`, `commit-trailer` | Accepted locations; **any one** of them satisfies the rule. `description` is a disclosure statement in the PR text (including an `Assisted-by:` line). `checkbox` is a ticked task-list item about AI use. `commit-trailer` is an `Assisted-by`, `Generated-by` or AI `Co-authored-by` trailer on at least one commit. A trailer the policy bans does not count. |
| `disclosure.example` | string | Shown in the message when a disclosure is missing. |
| `trailers.assisted_by` | `required`, `allowed`, `banned`, `unspecified` | `required`: every non-merge commit of an AI-assisted pull request needs an `Assisted-by:` trailer. `banned`: no commit may have one. |
| `trailers.co_authored_by_ai` | `allowed`, `banned`, `unspecified` | `banned`: no commit may have a `Co-authored-by:` trailer that names an AI tool. Human co-authors are never affected. |
| `human_only` | list of `review-replies`, `commit-messages`, `pr-description`, `issues` | Informational. Shown in the summary; not checked. |
| `assignment_required` | `true`/`false` | Every linked issue must be assigned to the pull request author. |
| `issue_first` | `true`/`false` | At least one linked issue must exist. |
| `required_labels` | list of label groups | An AND of OR-groups, applied to **every** linked issue. `[[triaged], [help wanted, good first issue]]` means `triaged` AND (`help wanted` OR `good first issue`). Comparison ignores case. |
| `dco` | `true`/`false` | Every non-merge commit needs a `Signed-off-by:` whose email matches the commit author's email. A sign-off by an AI tool identity is a violation, because only a person can certify the DCO. |
| `cla` | `true`/`false` | Informational; your CLA tooling checks it. |
| `signed_commits` | `true`/`false` | Every commit must have a signature that GitHub reports as verified. |
| `ui_screenshots_required` | `true`/`false` | Advisory notice when the description has no image. The Action cannot tell whether a pull request changes UI. |

**Scope.** The disclosure notice, the `assisted_by: banned` check and the `co_authored_by_ai: banned` check run on every pull request. All other rules apply only when AI assistance is indicated. Rules that do not apply are listed as skipped. For DCO or signed commits on every pull request, keep using your existing DCO app or branch protection.

**Linked issues** are GitHub's own linked issues (`closingIssuesReferences`) plus issues named with a closing keyword in the description (`Fixes #12`, `Closes owner/repo#3`, `Resolves https://github.com/o/r/issues/4`). Text inside HTML comments and code is ignored. If an issue cannot be read, for example because it is in a private repository, the rule shows **Not verified** rather than passing.

## How AI assistance is detected

A pull request is treated as AI-assisted when the contributor or their tools left a statement saying so:

- **A disclosure in the description.** Examples: "I used Claude Code to draft the retry loop", "Parts of this change were drafted with an LLM", "Generated with [Claude Code]", an answered `AI usage: Copilot for the tests` line, or an `Assisted-by:` line.
- **A ticked checkbox** whose text is about using AI, such as `- [x] I used AI tools`.
- **Commit trailers**: `Assisted-by`, `Generated-by`, or `Co-authored-by` naming a known AI tool identity. Examples: `Claude <noreply@anthropic.com>`, Copilot's GitHub noreply address, `cursoragent@cursor.com`, `noreply@aider.chat`, Devin's and Jules' bot accounts.
- **Tool attribution lines** in commit messages, such as `Generated with [Claude Code](...)`.
- **Commits authored by a tool identity**, such as Aider's default `Name (aider)` author.
- **AI agent accounts** as the pull request or commit author (`bot-authors`).

The detector favours precision over coverage. A false match would apply AI rules to a person's pull request, so it ignores:

- `AI` inside words (MAIN, TRAIN), and lowercase `cursor`, which is usually the database term.
- Sentences about AI *features* ("fixes a crash when using Copilot", "adds support for using an LLM").
- Unticked checkboxes, and boxes that only acknowledge a policy ("I have read the AI policy").
- Template text inside HTML comments, code blocks, and quoted text (`> ...`).
- Human co-authors, including people whose names are also tool names (Claude Debussy, Devin Smith, Jules Verne). Those names count only with a tool-owned email or a clear qualifier ("Devin AI").

Statements such as "No AI was used" or `AI usage: none` are recorded as negative disclosures. If they contradict another signal, for example an AI co-author trailer, the report shows a neutral notice.

## What it can and cannot detect

- **It cannot detect undisclosed AI use.** It only sees what was written: descriptions, trailers, identities and accounts. Code written with AI and submitted without saying so looks like any other code. The Action does not guess, and the "no disclosure found" message is a **notice**, never a violation or an accusation.
- **Detection is heuristic.** Unusual phrasing can be missed, and a rare sentence could be misread. The summary quotes the exact text behind every decision, so a maintainer can judge.
- **`human_only` rules are not checked.** Whether a person wrote a review reply cannot be determined from metadata.
- **UI screenshots are advisory.** The Action does not know whether a change affects UI.
- **Commit lists are capped by the API at 250 commits.** Larger pull requests are reported as **Not verified** for the commits that could not be read.
- **Label and assignment changes on a linked issue do not trigger a run.** Re-run the workflow, or edit the pull request, after triaging the issue.

## Security

- **No pull request code is checked out or executed.** The Action reads pull request metadata, commits, linked issues and the policy file through the GitHub API. Do not add `actions/checkout` of the pull request head to this job.
- **`pull_request_target` is recommended, and safe for this Action.** That event runs the workflow from the base branch, so a pull request cannot edit the workflow to skip the check. It also gets a token that can comment on pull requests from forks. Its risk comes from checking out and running untrusted code with that token, and this Action does neither. Keep the job to this one step, and do not give it secrets it does not need.
- **`pull_request` works for report-only setups.** Pull requests from forks get a read-only token there, so the comment cannot be posted (a warning explains this). The workflow file also comes from the pull request itself.
- **The policy is read from the base commit**, never from the pull request branch.
- **Use least privilege:** `contents: read`, `pull-requests: read` and `issues: read`, plus `pull-requests: write` only for comment mode.
- **The `report` output contains untrusted text** from the pull request. Pass it through `env:` and never inline it into a `run:` script with `${{ }}`, which allows script injection. In the report itself, quoted text is put in code spans, so @mentions and HTML in a pull request do not become active.

## Generating the policy

`contribpolicy`, a sibling command-line tool, can generate `.github/ai-policy.yml` from a project's written contribution rules. It is coming soon. Until then, start from one of the files in `examples/policies/`.

## Development

Requires Node.js 24 (Node.js 22.12+ also works for development).

```bash
npm ci
npm run typecheck
npm run lint
npm run build      # tsc, then ncc bundles to dist/index.js (committed)
npm test           # unit tests + end-to-end test of dist/index.js
```

The end-to-end test runs the bundled `dist/index.js` the way the runner does. It feeds the Action a fixture `pull_request_target` payload and inputs through `INPUT_*` variables, and points `GITHUB_API_URL` at a local server that returns fixture API responses. Rebuild before running it. CI fails if `dist/` is not up to date.

`runs.using` is `node24`. GitHub's runners switched JavaScript actions to Node 24 by default on 16 June 2026 and removed Node 20 on 23 September 2026.

## License

MIT. Copyright (c) 2026 Pujitha Paladugu. See [LICENSE](LICENSE).
