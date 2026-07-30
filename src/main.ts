import * as core from '@actions/core';
import { getChangedSkillFiles } from './changed-files.ts';
import { postOrUpdateComment } from './comment.ts';
import type { SkillReviewResult } from './skill-review.ts';
import {
  isAuthErrorMessage,
  isWorkspaceErrorMessage,
  runSkillReview,
} from './skill-review.ts';

const CONCURRENCY_LIMIT = 5;

async function main(): Promise<void> {
  const rootPath = process.env.INPUT_PATH || '.';
  const shouldComment = process.env.INPUT_COMMENT !== 'false';
  const threshold = parseThreshold(process.env.INPUT_FAIL_THRESHOLD);
  // Unset hands the choice to the CLI, which takes it from a `tessl.json` in the
  // repository or from the token's only workspace. A token that can see several
  // leaves it unresolvable, which the review reports as a workspace failure.
  const workspace = process.env.INPUT_WORKSPACE?.trim() || undefined;

  // 1. Detect changed SKILL.md files
  const changedFiles = await getChangedSkillFiles(rootPath);

  if (changedFiles.length === 0) {
    console.log('No SKILL.md files changed in this PR. Nothing to review.');
    return;
  }

  console.log(
    `Found ${changedFiles.length} changed SKILL.md file(s): ${changedFiles.join(', ')}`,
  );

  // 2. Run reviews with concurrency limit
  const results: SkillReviewResult[] = [];
  for (let i = 0; i < changedFiles.length; i += CONCURRENCY_LIMIT) {
    const batch = changedFiles.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.all(
      batch.map(async (filePath) => {
        console.log(`Reviewing ${filePath}...`);
        const result = await runSkillReview(filePath, threshold, workspace);
        const status = result.error
          ? 'ERROR'
          : result.passed
            ? 'PASSED'
            : 'FAILED';
        console.log(`  ${filePath}: ${status} (score: ${result.score})`);
        return result;
      }),
    );
    results.push(...batchResults);
  }

  // 3b. Write a job summary so scores and required changes are visible in the
  // Actions run itself — no click-through, and it still shows on fork PRs where
  // the PR comment can't be posted.
  await writeJobSummary(results, threshold);

  // 4. Post PR comment (may fail on fork PRs due to read-only token)
  if (shouldComment) {
    try {
      await postOrUpdateComment(results, threshold);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Could not post PR comment (expected for fork PRs): ${msg}`);
    }
  }

  // 5. Setup failures mean no review ran, so they are not score failures.
  // `fail-threshold: 0` disables score gating only; it must not hide these.
  const authFailures = results.filter((r) => isAuthErrorMessage(r.error));
  if (authFailures.length > 0) {
    const summary = authFailures.map((r) => `  ${r.skillPath}`).join('\n');
    core.setFailed(
      `Tessl authentication failed for ${authFailures.length} skill(s). Configure the tessl-token input with a Tessl API token stored in a GitHub secret.\n${summary}`,
    );
    return;
  }

  const workspaceFailures = results.filter((r) =>
    isWorkspaceErrorMessage(r.error),
  );
  if (workspaceFailures.length > 0) {
    const summary = workspaceFailures.map((r) => `  ${r.skillPath}`).join('\n');
    core.setFailed(
      `Tessl could not resolve a workspace to review against for ${workspaceFailures.length} skill(s). ` +
        'Set the `workspace` input to a workspace name or ID, or check the value if it is already set ' +
        '(`tessl workspace list` shows what the token can see). The CLI only picks one on its own when ' +
        'the repository has a linked `tessl.json` or the token can see exactly one workspace.\n' +
        summary,
    );
    return;
  }

  // 6. Check threshold
  if (threshold > 0) {
    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      const summary = failed
        .map((r) => `  ${r.skillPath}: ${r.score >= 0 ? `${r.score}%` : 'error'}`)
        .join('\n');
      core.setFailed(
        `${failed.length} skill(s) below threshold of ${threshold}%:\n${summary}`,
      );
    }
  }

  console.log('Skill review completed successfully.');
}

/**
 * Write a GitHub Actions job summary: one row per skill with its score and
 * pass/fail, then that skill's assessment, validation issues and suggestions.
 * Surfacing this here (not just in a collapsed PR comment section) means
 * reviewers see what to fix directly on the run, and it survives fork PRs where
 * the comment can't be posted.
 */
export async function writeJobSummary(
  results: SkillReviewResult[],
  threshold: number,
): Promise<void> {
  try {
    const summary = core.summary.addHeading('🔍 Tessl Skill Review', 2);

    summary.addTable([
      [
        { data: 'Skill', header: true },
        { data: 'Score', header: true },
        { data: 'Status', header: true },
      ],
      ...results.map((r) => {
        const status = r.error
          ? '⚠️ Error'
          : threshold > 0
            ? r.passed
              ? '✅ Pass'
              : '❌ Fail'
            : 'ℹ️ Reviewed';
        return [
          `<code>${r.skillPath}</code>`,
          r.score >= 0 ? `${r.score}%` : '—',
          status,
        ];
      }),
    ]);

    for (const r of results) {
      const labelled: Array<[string, string[]]> = r.error
        ? [['Error', [r.error]]]
        : [
            ['Validation issues', r.validationIssues ?? []],
            ['Suggestions', r.suggestions ?? []],
          ];
      const blocks = labelled.filter(([, items]) => items.length > 0);
      if (blocks.length === 0 && !r.overallAssessment) continue;

      summary.addHeading(r.skillPath, 3);
      if (r.overallAssessment) summary.addRaw(`> ${r.overallAssessment}\n\n`);
      for (const [label, items] of blocks) {
        // Markdown rather than `addList`, whose `<ul><li>` markup would leave
        // the icons and bold names in each item as literal characters.
        const list = items.map((i) => `- ${i}`).join('\n');
        summary.addRaw(`**${label}**\n\n${list}\n\n`);
      }
    }

    await summary.write();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`Could not write job summary: ${msg}`);
  }
}

export function parseThreshold(value: string | undefined): number {
  const num = Number(value ?? '0');
  if (Number.isNaN(num) || num < 0 || num > 100) {
    throw new Error(
      `Invalid fail-threshold: ${value}. Must be a number between 0 and 100.`,
    );
  }
  return num;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
