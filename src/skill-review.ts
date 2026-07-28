import { dirname, join } from 'node:path';

/**
 * Format a score dimension as a table row with visual bar.
 * `max` is a fallback only — we widen to the observed score rather than
 * assume a fixed scale (which previously crashed once dimension scores
 * exceeded the hardcoded default of 3). `tessl review run --json` does expose
 * the rubric scale under `judges.<judge>.scale`, but we keep the defensive
 * widening in case a plugin reports a score above its declared max.
 */
function scoreBar(score: number, max = 3): string {
  const effectiveMax = Math.max(max, score);
  const filled = '█'.repeat(score);
  const empty = '░'.repeat(effectiveMax - score);
  return `${filled}${empty} ${score}/${effectiveMax}`;
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
  /**
   * Required changes surfaced prominently (not hidden in a <details>):
   * failed/warning validation checks plus the content judge's suggestions.
   * Empty when the review is clean.
   */
  requiredChanges?: string[];
  /** One-line summary from the content judge, if present. */
  overallAssessment?: string;
}

interface Evaluation {
  scores?: Record<string, { score?: number; reasoning?: string }>;
  suggestions?: string[];
  overall_assessment?: string;
}

interface ReviewRunJson {
  review?: { reviewScore?: number };
  validation?: {
    overallPassed?: boolean;
    errorCount?: number;
    warningCount?: number;
    checks?: Array<{ name?: string; status?: string; message?: string }>;
  };
  judges?: {
    content?: { normalizedScore?: number; evaluation?: unknown };
    description?: { normalizedScore?: number; evaluation?: unknown };
  };
}

/**
 * Render validation checks. Returns the failing/warning check messages
 * (for prominent display) and a markdown block with all non-passing checks
 * listed, plus a collapsed full list.
 */
function formatValidation(
  validation: ReviewRunJson['validation'],
): { failures: string[]; markdown: string } {
  const checks = validation?.checks ?? [];
  if (checks.length === 0) return { failures: [], markdown: '' };

  const notPassed = checks.filter((c) => c.status && c.status !== 'passed');
  const failures = notPassed.map(
    (c) => `${c.message ?? c.name ?? 'validation issue'}`,
  );

  const parts: string[] = ['### Validation Checks', ''];
  if (notPassed.length === 0) {
    parts.push(`✅ All ${checks.length} checks passed.`);
  } else {
    for (const c of notPassed) {
      const icon = c.status === 'warning' ? '⚠️' : '❌';
      parts.push(`- ${icon} **${c.name}** — ${c.message ?? ''}`);
    }
  }
  return { failures, markdown: parts.join('\n') };
}

export function isAuthErrorMessage(message: string | undefined): boolean {
  if (!message) return false;
  return /requires you to be logged in|run tessl login|401 unauthorized|authentication required|not authenticated/i.test(
    message,
  );
}

export async function runSkillReview(
  skillFilePath: string,
  threshold: number,
  workspace: string,
): Promise<SkillReviewResult> {
  const skillDir = dirname(skillFilePath);

  // Tessl Review (replaces the deprecated `tessl skill review`). `review run`
  // is a single blocking call that runs the review to completion and, with
  // --json, emits the full result. A workspace is now required.
  const proc = Bun.spawn(
    ['tessl', 'review', 'run', 'quality', '--json', '--workspace', workspace, skillDir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const error = stderr || stdout || `Process exited with code ${exitCode}`;
    console.warn(
      `tessl review run failed for ${skillFilePath} (exit code ${exitCode}): ${error}`,
    );
    return {
      skillPath: skillFilePath,
      passed: threshold === 0 && !isAuthErrorMessage(error),
      score: -1,
      output: '',
      error,
    };
  }

  const jsonStr = extractJson(stdout);
  if (!jsonStr) {
    console.warn(`No JSON found in review output for ${skillFilePath}`);
    return {
      skillPath: skillFilePath,
      passed: threshold === 0,
      score: -1,
      output: stdout,
      error: 'Could not parse review output',
    };
  }

  let parsed: ReviewRunJson;
  try {
    parsed = JSON.parse(jsonStr) as ReviewRunJson;
  } catch {
    console.warn(`Failed to parse review JSON for ${skillFilePath}`);
    return {
      skillPath: skillFilePath,
      passed: threshold === 0,
      score: -1,
      output: jsonStr,
      error: 'Failed to parse JSON output',
    };
  }

  // `review.reviewScore` is already a 0-100 integer. Fall back to the content
  // judge's normalized score if a plugin omits the top-level score.
  const score =
    typeof parsed.review?.reviewScore === 'number'
      ? parsed.review.reviewScore
      : Math.round((parsed.judges?.content?.normalizedScore ?? 0) * 100);

  const contentEval = parsed.judges?.content?.evaluation as
    | Evaluation
    | undefined;
  const { failures: validationFailures, markdown: validationMarkdown } =
    formatValidation(parsed.validation);

  // Required changes surfaced prominently: failed validation checks first,
  // then the content judge's concrete suggestions.
  const suggestions =
    contentEval && Array.isArray(contentEval.suggestions)
      ? contentEval.suggestions.filter((s): s is string => typeof s === 'string')
      : [];
  const requiredChanges = [...validationFailures, ...suggestions];
  const overallAssessment =
    contentEval && typeof contentEval.overall_assessment === 'string'
      ? contentEval.overall_assessment
      : undefined;

  const outputParts: string[] = [];
  if (validationMarkdown) outputParts.push(validationMarkdown);
  if (parsed.judges?.content?.evaluation) {
    outputParts.push(
      '### Review Details\n\n' + formatEvaluation(parsed.judges.content.evaluation),
    );
  }
  if (parsed.judges?.description?.evaluation) {
    outputParts.push(
      '### Description Review\n\n' +
        formatEvaluation(parsed.judges.description.evaluation),
    );
  }

  return {
    skillPath: skillFilePath,
    passed: threshold === 0 || score >= threshold,
    score,
    output: outputParts.length > 0 ? outputParts.join('\n\n') : stdout,
    requiredChanges: requiredChanges.length > 0 ? requiredChanges : undefined,
    overallAssessment,
  };
}
