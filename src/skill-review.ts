import { dirname, join } from 'node:path';

/**
 * Extract the first complete top-level JSON object from a string
 * that may contain non-JSON text before/after it.
 */
export function extractJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

export interface SkillReviewResult {
  skillPath: string;
  passed: boolean;
  score: number;
  output: string;
  error?: string;
}

export async function runSkillReview(
  skillFilePath: string,
  threshold: number,
): Promise<SkillReviewResult> {
  const skillDir = dirname(skillFilePath);

  const proc = Bun.spawn(['tessl', 'skill', 'review', '--json', skillDir], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.warn(
      `tessl skill review failed for ${skillFilePath} (exit code ${exitCode}): ${stderr}`,
    );
    return {
      skillPath: skillFilePath,
      passed: threshold === 0,
      score: -1,
      output: '',
      error: stderr || `Process exited with code ${exitCode}`,
    };
  }

  const jsonStr = extractJson(stdout);
  if (!jsonStr) {
    console.warn(`No JSON found in skill review output for ${skillFilePath}`);
    return {
      skillPath: skillFilePath,
      passed: threshold === 0,
      score: -1,
      output: stdout,
      error: 'Could not parse review output',
    };
  }
  let parsed: {
    contentJudge?: { normalizedScore?: number; evaluation?: string };
    validation?: { output?: string };
  };

  try {
    parsed = JSON.parse(jsonStr) as typeof parsed;
  } catch {
    console.warn(`Failed to parse skill review JSON for ${skillFilePath}`);
    return {
      skillPath: skillFilePath,
      passed: threshold === 0,
      score: -1,
      output: jsonStr,
      error: 'Failed to parse JSON output',
    };
  }

  const normalizedScore = parsed.contentJudge?.normalizedScore ?? 0;
  const score = Math.round(normalizedScore * 100);

  const outputParts: string[] = [];
  if (parsed.validation?.output) {
    outputParts.push(
      '### Validation Checks\n\n' + parsed.validation.output,
    );
  }
  if (parsed.contentJudge?.evaluation) {
    outputParts.push(
      '### Review Details\n\n' + parsed.contentJudge.evaluation,
    );
  }

  return {
    skillPath: skillFilePath,
    passed: threshold === 0 || score >= threshold,
    score,
    output: outputParts.length > 0 ? outputParts.join('\n\n') : stdout,
  };
}
