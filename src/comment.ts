import * as github from '@actions/github';
import type { SkillReviewResult } from './skill-review.ts';

const COMMENT_MARKER = '<!-- tessl-skill-review -->';

/** Escape text for safe inclusion in markdown code fences */
function escapeForCodeFence(text: string): string {
  return text.replace(/```/g, '` ` `');
}

/** Escape text for safe inclusion in inline markdown */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>~]/g, '\\$&');
}

function formatComment(
  results: SkillReviewResult[],
  threshold: number,
): string {
  const sections = results.map((result) => {
    const scoreText =
      result.score >= 0 ? `Score: ${result.score}%` : 'Score: N/A';
    const emoji =
      result.error
        ? ' ⚠️'
        : threshold > 0 && result.score >= threshold
          ? ' ✅'
          : threshold > 0 && !result.passed
            ? ' ❌'
            : '';

    let body: string;
    if (result.error) {
      body = `\n> ⚠️ **Error:** ${escapeMarkdown(result.error)}\n`;
      if (result.output) {
        body += `\n<details>\n<summary>Output</summary>\n\n\`\`\`\n${escapeForCodeFence(result.output)}\n\`\`\`\n\n</details>\n`;
      }
    } else {
      body = `\n<details>\n<summary>Review Details</summary>\n\n${result.output}\n\n</details>\n`;
    }

    return `### \`${result.skillPath}\` — ${scoreText}${emoji}\n${body}`;
  });

  return `${COMMENT_MARKER}\n## 🔍 Tessl Skill Review\n\n${sections.join('\n---\n\n')}\n---\n\n*Powered by [Tessl](https://tessl.io) — evaluate and optimize your agent skills. Run \`npm i -g @tessl/cli && tessl skill review\` locally, or visit the [Tessl Registry](https://tessl.io/registry) to discover evaluated skills.*`;
}

export async function postOrUpdateComment(
  results: SkillReviewResult[],
  threshold: number,
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to post comments');
  }

  const context = github.context;
  if (!context.payload.pull_request) {
    throw new Error('No pull request context found');
  }

  const octokit = github.getOctokit(token);
  const prNumber = context.payload.pull_request.number;
  const body = formatComment(results, threshold);

  // Look for an existing comment from this action (paginate to find it)
  let existing: { id: number; body?: string | null } | undefined;
  let commentPage = 1;

  while (!existing) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
      per_page: 100,
      page: commentPage,
    });

    existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
    if (comments.length < 100) break;
    commentPage++;
  }

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existing.id,
      body,
    });
    console.log(`Updated existing PR comment (id: ${existing.id})`);
  } else {
    await octokit.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
      body,
    });
    console.log('Posted new PR comment');
  }
}
