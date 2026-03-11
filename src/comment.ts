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

const TESSL_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 21 24"><path fill="%23f8f8f8" d="M5.8 10.47c0-.21.22-.35.4-.24l3.75 2.2v4.95c0 .87.92 1.4 1.65.96l3.6-2.17v5.41l-3.6 2.12c-.69.4-1.52.4-2.2 0l-3.6-2.12zM21 16.9c0 .8-.42 1.53-1.1 1.93l-3.6 2.12V15.5l4.7-2.85zM4.7 15.4v5.53l-3.6-2.12A2.2 2.2 0 0 1 0 16.89v-4.24zM19.9 5.19c.68.4 1.1 1.13 1.1 1.93v4.23l-9.54 5.79c-.19.1-.42-.03-.42-.24v-4.46l4.57-2.7a.84.84 0 0 0 0-1.44l-4.07-2.44 4.75-2.8zm-5.65 3.59c.19.1.19.38 0 .48l-3.75 2.2-4.56-2.68a.82.82 0 0 0-1.24.73v4.61L0 11.36V7.12c0-.8.42-1.54 1.1-1.93l3.6-2.13zM9.4.3c.68-.4 1.51-.4 2.2 0l3.6 2.12-4.75 2.79L5.8 2.42z"/></svg>`;

function scoreBadge(score: number): string {
  const color =
    score >= 80 ? 'brightgreen' : score >= 60 ? 'yellow' : score >= 40 ? 'orange' : 'red';
  const logoParam = encodeURIComponent(TESSL_LOGO_SVG);
  return `![score](https://img.shields.io/badge/review_score-${score}%25-${color}?logo=${logoParam})`;
}

function formatComment(
  results: SkillReviewResult[],
  threshold: number,
): string {
  const sections = results.map((result) => {
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
      const badge = result.score >= 0 ? `\n${scoreBadge(result.score)}${emoji}\n` : '';
      body = `${badge}\n<details>\n<summary>Review Details</summary>\n\n${result.output}\n\n</details>\n`;
    }

    return `### \`${result.skillPath}\`\n${body}`;
  });

  const footer = [
    '---',
    '',
    'To improve your skill, point your Claude Code to [this Tessl guide](https://docs.tessl.io/evaluate/optimize-a-skill-using-best-practices) and ask it to *optimize* your skill. [@fernandezbaptiste](https://github.com/fernandezbaptiste) if you hit any issues.',
  ].join('\n');

  return `${COMMENT_MARKER}\n## 🔍 Tessl Skill Review\n\n${sections.join('\n---\n\n')}\n${footer}`;
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
