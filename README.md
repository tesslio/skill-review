# Tessl Skill Review Action

A GitHub Action that automatically reviews `SKILL.md` files changed in a pull request and posts the results as a PR comment.

**No authentication required.** This action runs `tessl skill review` locally — no Tessl account or API token needed. The only token used is the GitHub-provided `GITHUB_TOKEN` for posting PR comments.

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
      - uses: tesslio/skill-review@22e928dd837202b2b1d1397e0114c92e0fae5ead
```

That's it. Any PR that modifies a `SKILL.md` file will get an automated review comment.

> **Pin to SHA for supply-chain safety.** The example above pins to a specific commit rather than `@main`. This ensures your CI only runs code you've reviewed. To update, check the [latest commit on main](https://github.com/tesslio/skill-review/commits/main) and replace the SHA.

## Inputs

| Input | Description | Default |
|---|---|---|
| `path` | Root path to search for SKILL.md files | `.` |
| `comment` | Whether to post results as a PR comment | `true` |
| `fail-threshold` | Minimum score (0-100) to pass. Set to `0` to never fail. | `0` |

### Setting a quality gate

To enforce a minimum skill quality score, set `fail-threshold`:

```yaml
- uses: tesslio/skill-review@22e928dd837202b2b1d1397e0114c92e0fae5ead
  with:
    fail-threshold: 70
```

PRs with any skill scoring below 70% will fail the check.

## How it works

1. Detects which `SKILL.md` files were changed in the PR
2. Installs the [Tessl CLI](https://tessl.io)
3. Runs `tessl skill review` on each changed skill
4. Posts (or updates) a review comment on the PR with scores and detailed feedback
5. Optionally fails the check if any score is below the threshold

## Comment behavior

The action posts a single comment per PR. On subsequent pushes, it updates the existing comment rather than creating a new one.

## Local development

```bash
bun install
bun run lint
```

## License

MIT
