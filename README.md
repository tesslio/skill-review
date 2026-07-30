# Tessl Skill Review Action

A GitHub Action that automatically reviews `SKILL.md` files changed in a pull request and posts the results as a PR comment.

This action runs [Tessl Review](https://docs.tessl.io) and needs a **Tessl API token**. Store it as a GitHub repository secret, for example `TESSL_TOKEN`, and pass it with the `tessl-token` input. Reviews need Tessl CLI 0.90.0 or later, which the action installs by default.

Reviews run against one Tessl workspace. The CLI picks it for you when the repository has a `tessl.json` linked to a workspace, or when your token can see exactly one. A token that can see several — usual for an organisation account — needs the `workspace` input, and the check fails asking for it until you set one.

## Usage

Add this workflow to your repository at `.github/workflows/skill-review.yml`:

```yaml
name: Tessl Skill Review
on:
  pull_request:
    paths: ['**/SKILL.md']

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: tesslio/skill-review@main
        with:
          tessl-token: ${{ secrets.TESSL_TOKEN }}
```

Any PR that modifies a `SKILL.md` file will get an automated review comment. If your token can see more than one workspace, add `workspace: your-workspace` — `tessl workspace list` shows the names.

## Inputs

| Input | Description | Default |
|---|---|---|
| `workspace` | Tessl workspace name or ID reviews run against (see `tessl workspace list`). Leave unset to let the CLI resolve it from a linked `tessl.json` or from the token's only workspace. | unset |
| `path` | Root path to search for SKILL.md files | `.` |
| `comment` | Whether to post results as a PR comment | `true` |
| `fail-threshold` | Minimum score (0-100) to pass. Set to `0` to never fail. | `0` |
| `tessl-token` | Tessl API token used to authenticate review requests. Store it as a GitHub secret. | unset |

### Setting a quality gate

To enforce a minimum skill quality score, set `fail-threshold`:

```yaml
- uses: tesslio/skill-review@main
  with:
    tessl-token: ${{ secrets.TESSL_TOKEN }}
    fail-threshold: 70
```

PRs with any skill scoring below 70% will fail the check.

## How it works

1. Detects which `SKILL.md` files were changed in the PR
2. Installs the [Tessl CLI](https://tessl.io)
3. Runs `tessl review run quality` on each changed skill
4. Posts (or updates) a review comment on the PR — with the assessment and any validation issues up front — and writes a job summary
5. Optionally fails the check if any score is below the threshold

## Comment behavior

The action posts a single comment per PR. On subsequent pushes, it updates the existing comment rather than creating a new one. The reviewer's assessment and any validation check that didn't pass are shown at the top of the comment, and the run's job summary lists them alongside the reviewer's suggestions, so authors don't have to expand anything to see what to fix.

## Local development

```bash
bun install
bun run lint
```

## License

MIT
