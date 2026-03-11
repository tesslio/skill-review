import { dirname, join } from 'node:path';

/** Format a score dimension as a table row with visual bar */
function scoreBar(score: number, max = 3): string {
  const filled = '█'.repeat(score);
  const empty = '░'.repeat(max - score);
  return `${filled}${empty} ${score}/${max}`;
}

/**
 * Format the evaluation object into readable markdown.
 * Handles the known shape: { scores, overall_assessment, suggestions }
 * Falls back to JSON for unknown shapes.
 */
function formatEvaluation(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) {
    return JSON.stringify(value, null, 2);
  }

  const eval_ = value as Record<string, unknown>;
  const parts: string[] = [];

  // Format scores as a table
  if (eval_.scores && typeof eval_.scores === 'object') {
    const scores = eval_.scores as Record<
      string,
      { score?: number; reasoning?: string }
    >;
    parts.push('| Dimension | Score | Detail |');
    parts.push('|-----------|-------|--------|');
    for (const [key, val] of Object.entries(scores)) {
      const label = key.replace(/_/g, ' ');
      const bar = typeof val.score === 'number' ? scoreBar(val.score) : '—';
      const reasoning = val.reasoning ?? '';
      parts.push(`| **${label}** | ${bar} | ${reasoning} |`);
    }
  }

  // Overall assessment
  if (typeof eval_.overall_assessment === 'string') {
    parts.push('', `**Overall:** ${eval_.overall_assessment}`);
  }

  // Suggestions as a checklist
  if (Array.isArray(eval_.suggestions) && eval_.suggestions.length > 0) {
    parts.push('', '**Suggestions:**');
    for (const s of eval_.suggestions) {
      parts.push(`- ${s}`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : JSON.stringify(value, null, 2);
}

/** Safely convert an unknown value to a readable string */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

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
    contentJudge?: { normalizedScore?: number; evaluation?: unknown };
    validation?: { output?: unknown };
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
      '### Validation Checks\n\n' + stringify(parsed.validation.output),
    );
  }
  if (parsed.contentJudge?.evaluation) {
    outputParts.push(
      '### Review Details\n\n' + formatEvaluation(parsed.contentJudge.evaluation),
    );
  }

  return {
    skillPath: skillFilePath,
    passed: threshold === 0 || score >= threshold,
    score,
    output: outputParts.length > 0 ? outputParts.join('\n\n') : stdout,
  };
}
