# Listing AI Contribution Check on the GitHub Marketplace

The Marketplace listing is made from a GitHub release. Only the repository owner can do it, in the
browser, with two-factor authentication on. GitHub does not review the listing: it goes live as soon as the
release is saved, provided the requirements below are met.

## Requirements (checked on 2026-10-19)

| Requirement (from GitHub's "Publishing actions in GitHub Marketplace") | Status |
| --- | --- |
| The repository is public | Yes |
| Exactly one action metadata file at the root (`action.yml`) | Yes; there are no other `action.yml`/`action.yaml` files |
| `name` is unique: not an existing Marketplace action, not a GitHub user or organization, not a Marketplace category, not a GitHub feature | `AI Contribution Check` is free: <https://github.com/marketplace/actions/ai-contribution-check> returns 404 (listed actions return 200), and there is no user or organization `ai-contribution-check` |
| `description` is at most 125 characters | 117 characters |
| `branding.icon` is a supported Feather icon | `check-square` is in the list |
| `branding.color` is one of `white`, `black`, `yellow`, `blue`, `green`, `orange`, `red`, `purple`, `gray-dark` | `blue` |
| `author` is set | `Pujitha Paladugu` |
| Workflow files | GitHub's current rules allow them; `.github/workflows/ci.yml` does not block the listing |

Someone else could still take the name before you publish, so publish soon. Do not change `name` in
`action.yml` afterwards: the listing is tied to it.

## Before you start

1. Make sure your GitHub account has two-factor authentication on (**Settings → Password and
   authentication**). Publishing a Marketplace release requires it.
2. Push the latest `main` (this file and the README update) from curie. The action code and `dist/` are
   unchanged since `v0.1.0`, so no new version is needed.

## Publish the listing

The **Release Action** section that holds the Marketplace checkbox appears on the release form. You can
reach it in two ways; both end in the same steps.

- **A. Recommended now: edit the existing `v0.1.0` release.** It already points at the current action
  code. Open <https://github.com/pujitha24/ai-contribution-check/releases/tag/v0.1.0> and click the pencil
  (**Edit**).
- **B. With the next version: draft a new release.** Open
  <https://github.com/pujitha24/ai-contribution-check/blob/main/action.yml>. GitHub shows a banner offering
  to publish the action to the Marketplace. Click **Draft a release** and choose the new tag (create and push
  a signed tag on curie first, for example `git tag -s v0.2.0 -m "AI Contribution Check v0.2.0"`, then move
  `v0` to it).

Then:

1. Under **Release Action**, tick **Publish this Action to the GitHub Marketplace**.
2. If the checkbox is greyed out, click the **accept the GitHub Marketplace Developer Agreement** link next
   to it, read and accept the agreement, then come back to the release form and tick the box.
3. Wait for the metadata check. It should say **Everything looks good!** If it shows an error or warning
   about `action.yml`, stop and fix the file first.
4. Choose the categories:
   - **Primary Category: Code review.** The action checks every pull request and reports in the PR, as
     part of review.
   - **Another Category: Open Source management.** Its users are maintainers enforcing their contribution
     rules (disclosure, trailers, DCO, linked issues).

   Do not pick **AI Assisted**: the action uses no AI model itself (it is deterministic), and that category
   would mislead people. **Code quality** is a reasonable alternative for the second slot.
5. Leave the tag and the title as they are (option A), or fill in the new tag, a title such as
   `AI Contribution Check v0.2.0` and the release notes (option B).
6. Click **Update release** (A) or **Publish release** (B). Confirm with your 2FA code if asked.

## Check the result

1. Open <https://github.com/marketplace/actions/ai-contribution-check>. The page should show the name, the
   description, the blue `check-square` badge and the README.
2. Optional: add a Marketplace badge to the README:

   ```markdown
   [![GitHub Marketplace](https://img.shields.io/badge/Marketplace-AI%20Contribution%20Check-blue?logo=github)](https://github.com/marketplace/actions/ai-contribution-check)
   ```

## Later releases

Each new release has the same **Publish this Action to the GitHub Marketplace** checkbox; tick it to make
that release the version shown on the listing. Keep the `v0` tag pointing at the latest `v0.x.y` release, so
users of `@v0` get it.

To take the listing down, edit every release that has the box ticked, untick it and click **Update
release**.
