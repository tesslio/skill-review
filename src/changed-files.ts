import * as github from '@actions/github';
import { join } from 'node:path';

export async function getChangedSkillFiles(
  rootPath: string,
): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to detect changed files');
  }

  const context = github.context;
  if (!context.payload.pull_request) {
    throw new Error(
      'This action must run on pull_request events. No pull request context found.',
    );
  }

  const octokit = github.getOctokit(token);
  const prNumber = context.payload.pull_request.number;

  const changedFiles: string[] = [];
  let page = 1;

  while (true) {
    const response = await octokit.rest.pulls.listFiles({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });

    for (const file of response.data) {
      if (file.status === 'removed') continue;
      if (file.filename.endsWith('/SKILL.md') || file.filename === 'SKILL.md') {
        changedFiles.push(join(rootPath, file.filename));
      }
    }

    if (response.data.length < 100) break;
    page++;
  }

  return changedFiles;
}
