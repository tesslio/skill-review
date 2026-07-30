import { dirname } from 'node:path';

/** One judge's verdict: a score and reasoning per rubric dimension, plus prose. */
interface Evaluation {
  scores?: Record<string, { score?: number; reasoning?: string }>;
  suggestions?: string[];
  overall_assessment?: string;
}

interface JudgeResult {
  normalizedScore?: number;
  /** The rubric's scoring scale — `max` is the denominator for every dimension score. */
  scale?: { min?: number; max?: number };
  evaluation?: Evaluation | string;
}

/** The `tessl review run quality --json` payload. */
interface ReviewRunJson {
  /** `reviewScore` is a 0-100 integer, or null when the judges never ran. */
  review?: { reviewScore?: number | null };
  validation?: {
    overallPassed?: boolean;
    errorCount?: number;
    warningCount?: number;
    checks?: Array<{ name?: string; status?: string; message?: string }>;
  };
  /** Keyed by judge id: `content` and `description` for the skill rubrics. */
  judges?: Record<string, JudgeResult | undefined>;
}

/**
 * Narrowest denominator to assume for a judge that reports dimension scores
 * without a `scale`. Those payloads come from the older 1-3 rubric.
 */
const LEGACY_SCALE_MAX = 3;

/**
 * The denominator to render a judge's dimension scores against: its declared
 * rubric scale, or — for a payload that omits one — the highest score it
 * reported, so a rubric wider than 1-3 isn't rendered as full marks.
 */
function scaleMaxOf(judge: JudgeResult, evaluation: Evaluation): number {
  if (judge.scale?.max !== undefined) return judge.scale.max;
  const scores = Object.values(evaluation.scores ?? {}).map((s) => s.score ?? 0);
  return Math.max(LEGACY_SCALE_MAX, ...scores);
}

/**
 * Format one dimension's score as a bar. `max` is the rubric's top score, so a
 * 1-5 rubric renders `████░ 4/5`. Both counts are clamped to the scale, since
 * `repeat` rejects a negative count.
 */
function scoreBar(score: number, max: number): string {
  const filled = '█'.repeat(Math.max(0, Math.min(score, max)));
  const empty = '░'.repeat(Math.max(0, max - score));
  return `${filled}${empty} ${score}/${max}`;
}

/**
 * Render a judge's evaluation as a per-dimension table followed by its
 * suggestions. Empty when the judge reported no evaluation; falls back to JSON
 * for one that carries no scores. The judge's `overall_assessment` is rendered
 * by the caller above the collapsed details, so it is left out here.
 */
function formatEvaluation(judge: JudgeResult | undefined): string {
  const evaluation = judge?.evaluation;
  if (judge === undefined || evaluation === undefined) return '';
  if (typeof evaluation === 'string') return evaluation;

  const scores = evaluation.scores;
  if (!scores) return JSON.stringify(evaluation, null, 2);

  const scaleMax = scaleMaxOf(judge, evaluation);
  const parts: string[] = [
    '| Dimension | Score | Detail |',
    '|-----------|-------|--------|',
  ];
  for (const [key, val] of Object.entries(scores)) {
    const label = key.replace(/_/g, ' ');
    const bar =
      typeof val.score === 'number' ? scoreBar(val.score, scaleMax) : '—';
    const reasoning = (val.reasoning ?? '').replace(/\|/g, '\\|');
    parts.push(`| **${label}** | ${bar} | ${reasoning} |`);
  }

  const suggestions = evaluation.suggestions ?? [];
  if (suggestions.length > 0) {
    parts.push('', '**Suggestions:**');
    for (const s of suggestions) parts.push(`- ${s}`);
  }

  return parts.join('\n');
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
  /** Validation checks that didn't pass, rendered above the collapsed details. */
  validationIssues?: string[];
  /** The content judge's suggestions, listed in the run's job summary. */
  suggestions?: string[];
  /** The content judge's one-line summary, when the payload carries one. */
  overallAssessment?: string;
}

/**
 * The review score on a 0-100 scale, or `null` when the payload carries none.
 *
 * A judge's `normalizedScore` is deliberately not used as a substitute: it
 * measures one rubric rather than the review, and the two are far apart. On a
 * skill whose review scored 62, the content judge normalized to 0.2 — reporting
 * 20% would be a wrong number rather than a missing one.
 */
function reviewScoreFrom(parsed: ReviewRunJson): number | null {
  return typeof parsed.review?.reviewScore === 'number'
    ? parsed.review.reviewScore
    : null;
}

/**
 * Split the validation checks into the ones worth showing up front — anything
 * that didn't pass, each with its own error/warning icon — and a one-line tally
 * for the collapsed details. Each check renders in exactly one of them.
 */
function formatValidation(validation: ReviewRunJson['validation']): {
  issues: string[];
  markdown: string;
} {
  const checks = validation?.checks ?? [];
  if (checks.length === 0) return { issues: [], markdown: '' };

  const notPassed = checks.filter((c) => c.status && c.status !== 'passed');
  const issues = notPassed.map((c) => {
    const icon = c.status === 'warning' ? '⚠️' : '❌';
    const detail = c.message ? ` — ${c.message}` : '';
    return `${icon} **${c.name ?? 'validation issue'}**${detail}`;
  });

  const passedCount = checks.length - notPassed.length;
  const markdown = `### Validation Checks\n\n${passedCount}/${checks.length} checks passed.`;
  return { issues, markdown };
}

/**
 * Whether the CLI failed for want of credentials. The alternatives cover both
 * ways it reports that: a run with no stored auth at all asks the reader to
 * authenticate, and a rejected token surfaces as an authentication failure.
 * Both phrase the remedy as `tessl login` with the command in backticks, so the
 * pattern allows for them.
 */
export function isAuthErrorMessage(message: string | undefined): boolean {
  if (!message) return false;
  return /requires you to be logged in|run `?tessl login|401 unauthorized|please authenticate|authentication (failed|required)|not authenticated/i.test(
    message,
  );
}

/** The CLI's own text when it wants the flag this action's `workspace` input supplies. */
function mentionsWorkspaceFlag(message: string): boolean {
  return /--workspace/.test(message);
}

/**
 * Whether the CLI could not settle on a workspace: either it needs one — which
 * it reports as a missing `--workspace` flag when no `tessl.json` links a
 * project and the token can see more than one — or the workspace it was given
 * does not exist. Neither ran a review.
 */
export function isWorkspaceErrorMessage(message: string | undefined): boolean {
  if (!message) return false;
  return mentionsWorkspaceFlag(message) || /workspace not found/i.test(message);
}

/**
 * Whether a failure means no review ran at all, as opposed to a skill scoring
 * badly. `fail-threshold: 0` turns off score gating and must not turn these off
 * with it, or the check goes green having reviewed nothing.
 */
export function isSetupErrorMessage(message: string | undefined): boolean {
  return isAuthErrorMessage(message) || isWorkspaceErrorMessage(message);
}

/** Guidance appended to the CLI's own error, which names a flag rather than an input. */
const WORKSPACE_MISSING_HINT =
  'Set the workspace input to the Tessl workspace this repository reviews against. ' +
  'The token can see more than one, so the CLI cannot choose for you. ' +
  'Run tessl workspace list to see the names.';

/** Guidance for a workspace input the token cannot resolve to a workspace. */
const WORKSPACE_UNKNOWN_HINT =
  'Check the workspace input names a workspace this token can see. ' +
  'Run tessl workspace list to see the names.';

/**
 * Argv for a single blocking quality review of `skillDir`.
 *
 * `--threshold 0` is the CLI's explicit "never fail" value. Without it the
 * command exits non-zero whenever `validation.overallPassed` is false, this
 * function's caller bails on the exit code before parsing the JSON the CLI
 * already printed, and a skill with validation issues renders as an action error
 * instead of a score plus the issues themselves. Gating belongs to the action,
 * so the CLI must never gate.
 *
 * `--workspace` is omitted when the input is unset. The CLI then takes the
 * workspace from a `tessl.json` in the repository, or picks the only one the
 * token can see — a token with access to several is an error it can't resolve,
 * which `runSkillReview` turns into a request for the `workspace` input.
 */
function reviewRunArgs(
  skillDir: string,
  workspace: string | undefined,
): string[] {
  return [
    'tessl',
    'review',
    'run',
    'quality',
    '--json',
    ...(workspace ? ['--workspace', workspace] : []),
    '--threshold',
    '0',
    skillDir,
  ];
}

export async function runSkillReview(
  skillFilePath: string,
  threshold: number,
  workspace?: string,
): Promise<SkillReviewResult> {
  const skillDir = dirname(skillFilePath);

  const proc = Bun.spawn(reviewRunArgs(skillDir, workspace), {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const cliError = stderr || stdout || `Process exited with code ${exitCode}`;
    // The CLI's message names its own flag, or a workspace the token can't see.
    // Either way the fix is applied through this action's input, so say so.
    const workspaceHint = mentionsWorkspaceFlag(cliError)
      ? WORKSPACE_MISSING_HINT
      : isWorkspaceErrorMessage(cliError)
        ? WORKSPACE_UNKNOWN_HINT
        : undefined;
    const error = workspaceHint
      ? `${cliError.trim()}\n\n${workspaceHint}`
      : cliError;
    console.warn(
      `tessl review run failed for ${skillFilePath} (exit code ${exitCode}): ${error}`,
    );
    return {
      skillPath: skillFilePath,
      passed: threshold === 0 && !isSetupErrorMessage(error),
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

  // A skill that fails validation is scored `null` because the judges never
  // run. That is a review to report — the validation errors below are exactly
  // what the author needs — so it scores 0 rather than erroring. A score missing
  // for any other reason has no such explanation.
  const validationFailed = parsed.validation?.overallPassed === false;
  const reviewScore = reviewScoreFrom(parsed);
  if (reviewScore === null && !validationFailed) {
    console.warn(`Review output carried no score for ${skillFilePath}`);
    return {
      skillPath: skillFilePath,
      passed: threshold === 0,
      score: -1,
      output: jsonStr,
      error: 'Review completed without a score',
    };
  }
  const score = reviewScore ?? 0;

  const content = parsed.judges?.content;
  const contentEval = content?.evaluation;
  const overallAssessment =
    typeof contentEval === 'object' ? contentEval.overall_assessment : undefined;
  const suggestions =
    typeof contentEval === 'object' ? (contentEval.suggestions ?? []) : [];

  const { issues: validationIssues, markdown: validationMarkdown } =
    formatValidation(parsed.validation);

  const outputParts: string[] = [];
  if (validationMarkdown) outputParts.push(validationMarkdown);

  const contentDetails = formatEvaluation(content);
  if (contentDetails) outputParts.push(`### Review Details\n\n${contentDetails}`);

  const descriptionDetails = formatEvaluation(parsed.judges?.description);
  if (descriptionDetails) {
    outputParts.push(`### Description Review\n\n${descriptionDetails}`);
  }

  return {
    skillPath: skillFilePath,
    passed: threshold === 0 || score >= threshold,
    score,
    output: outputParts.length > 0 ? outputParts.join('\n\n') : stdout,
    validationIssues: validationIssues.length > 0 ? validationIssues : undefined,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
    overallAssessment,
  };
}
