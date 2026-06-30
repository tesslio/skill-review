# Tessl Skill Review Action

A GitHub Action that automatically reviews `SKILL.md` files changed in a pull request and posts the results as a PR comment.

This action requires a Tessl API token. Store the token as a GitHub repository secret, for example `TESSL_TOKEN`, and pass it with the `tessl-token` input.

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

Any PR that modifies a `SKILL.md` file will get an automated review comment.

## Inputs

| Input | Description | Default |
|---|---|---|
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
