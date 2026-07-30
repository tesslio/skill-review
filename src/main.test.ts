import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillReviewResult } from './skill-review.ts';

// ---------------------------------------------------------------------------
// Mock @actions/core and @actions/github at module level
// ---------------------------------------------------------------------------

// The real module supplies `summary`, so the job-summary writer can be tested
// by the file it produces rather than against a stub.
const actualCore = await import('@actions/core');

mock.module('@actions/core', () => ({
  ...actualCore,
  setFailed: mock(() => {}),
  getInput: mock(() => ''),
  info: mock(() => {}),
  warning: mock(() => {}),
  error: mock(() => {}),
  ExitCode: { Success: 0, Failure: 1 },
}));

const listFilesMock = mock(() =>
  Promise.resolve({ data: [] as Array<{ filename: string; status: string }> }),
);

const createCommentMock = mock(() => Promise.resolve());
const updateCommentMock = mock(() => Promise.resolve());
const listCommentsMock = mock(() =>
  Promise.resolve({ data: [] as Array<{ id: number; body: string }> }),
);

mock.module('@actions/github', () => ({
  context: {
    payload: { pull_request: { number: 42 } },
    repo: { owner: 'test-owner', repo: 'test-repo' },
  },
  getOctokit: () => ({
    rest: {
      pulls: { listFiles: listFilesMock },
      issues: {
        listComments: listCommentsMock,
        createComment: createCommentMock,
        updateComment: updateCommentMock,
      },
    },
  }),
}));

// Import after mock registration
const { getChangedSkillFiles } = await import('./changed-files.ts');
const {
  runSkillReview,
  extractJson,
  isAuthErrorMessage,
  isWorkspaceErrorMessage,
  isSetupErrorMessage,
} = await import('./skill-review.ts');
const { postOrUpdateComment } = await import('./comment.ts');
const { parseThreshold, writeJobSummary } = await import('./main.ts');

// ---------------------------------------------------------------------------
// 1. parseThreshold
// ---------------------------------------------------------------------------

describe('parseThreshold', () => {
  test('returns 0 for undefined', () => {
    expect(parseThreshold(undefined)).toBe(0);
  });

  test('returns 0 for "0"', () => {
    expect(parseThreshold('0')).toBe(0);
  });

  test('returns 50 for "50"', () => {
    expect(parseThreshold('50')).toBe(50);
  });

  test('returns 100 for "100"', () => {
    expect(parseThreshold('100')).toBe(100);
  });

  test('throws for -1', () => {
    expect(() => parseThreshold('-1')).toThrow('Invalid fail-threshold');
  });

  test('throws for 101', () => {
    expect(() => parseThreshold('101')).toThrow('Invalid fail-threshold');
  });

  test('throws for NaN string', () => {
    expect(() => parseThreshold('NaN')).toThrow('Invalid fail-threshold');
  });

  test('throws for "abc"', () => {
    expect(() => parseThreshold('abc')).toThrow('Invalid fail-threshold');
  });
});

// ---------------------------------------------------------------------------
// 2. extractJson
// ---------------------------------------------------------------------------

describe('extractJson', () => {
  test('extracts JSON from clean input', () => {
    const json = '{"key": "value"}';
    expect(extractJson(json)).toBe(json);
  });

  test('extracts JSON with leading text', () => {
    expect(extractJson('some log output\n{"key": 1}')).toBe('{"key": 1}');
  });

  test('extracts JSON with trailing text', () => {
    expect(extractJson('{"key": 1}\nmore text')).toBe('{"key": 1}');
  });

  test('extracts nested JSON', () => {
    const json = '{"a": {"b": {"c": 1}}}';
    expect(extractJson(`prefix ${json} suffix`)).toBe(json);
  });

  test('handles strings with braces', () => {
    const json = '{"text": "hello { world }"}';
    expect(extractJson(json)).toBe(json);
  });

  test('handles escaped quotes in strings', () => {
    const json = '{"text": "say \\"hello\\""}';
    expect(extractJson(json)).toBe(json);
  });

  test('returns null for no JSON', () => {
    expect(extractJson('no json here')).toBeNull();
  });

  test('returns null for unclosed brace', () => {
    expect(extractJson('{ unclosed')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. getChangedSkillFiles
// ---------------------------------------------------------------------------

describe('getChangedSkillFiles', () => {
  const originalToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'fake-token';
    listFilesMock.mockClear();
  });

  afterEach(() => {
    if (originalToken !== undefined) {
      process.env.GITHUB_TOKEN = originalToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  test('filters for SKILL.md files only', async () => {
    listFilesMock.mockResolvedValueOnce({
      data: [
        { filename: 'skills/my-skill/SKILL.md', status: 'modified' },
        { filename: 'README.md', status: 'modified' },
        { filename: 'src/index.ts', status: 'added' },
        { filename: 'SKILL.md', status: 'added' },
      ],
    });

    const result = await getChangedSkillFiles('.');
    expect(result).toEqual(['skills/my-skill/SKILL.md', 'SKILL.md']);
  });

  test('skips removed files', async () => {
    listFilesMock.mockResolvedValueOnce({
      data: [
        { filename: 'skills/removed/SKILL.md', status: 'removed' },
        { filename: 'skills/kept/SKILL.md', status: 'modified' },
      ],
    });

    const result = await getChangedSkillFiles('.');
    expect(result).toEqual(['skills/kept/SKILL.md']);
  });

  test('handles pagination (>100 files)', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      filename: i === 50 ? 'skills/page1/SKILL.md' : `src/file${i}.ts`,
      status: 'modified',
    }));
    const page2 = [
      { filename: 'skills/page2/SKILL.md', status: 'added' },
      { filename: 'src/other.ts', status: 'modified' },
    ];

    listFilesMock
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });

    const result = await getChangedSkillFiles('.');
    expect(result).toEqual([
      'skills/page1/SKILL.md',
      'skills/page2/SKILL.md',
    ]);
    expect(listFilesMock).toHaveBeenCalledTimes(2);
  });

  test('prepends rootPath when not "."', async () => {
    listFilesMock.mockResolvedValueOnce({
      data: [
        { filename: 'skills/my-skill/SKILL.md', status: 'modified' },
      ],
    });

    const result = await getChangedSkillFiles('/workspace');
    expect(result).toEqual(['/workspace/skills/my-skill/SKILL.md']);
  });

  test('throws when GITHUB_TOKEN is missing', async () => {
    delete process.env.GITHUB_TOKEN;
    await expect(getChangedSkillFiles('.')).rejects.toThrow(
      'GITHUB_TOKEN is required',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. runSkillReview
// ---------------------------------------------------------------------------

describe('runSkillReview', () => {
  function makeMockSpawn(
    stdout: string,
    stderr: string,
    exitCode: number,
  ) {
    return mock((..._args: unknown[]) => ({
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stdout));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stderr));
          controller.close();
        },
      }),
      exited: Promise.resolve(exitCode),
    }));
  }

  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    // @ts-ignore restoring original
    Bun.spawn = originalSpawn;
  });

  const WS = 'test-workspace';

  test('successful review with JSON output', async () => {
    const jsonOutput = JSON.stringify({
      review: { reviewScore: 85 },
      validation: {
        overallPassed: true,
        checks: [
          { name: 'frontmatter_valid', status: 'passed', message: 'YAML frontmatter is valid' },
        ],
      },
      judges: {
        content: { normalizedScore: 0.85, evaluation: 'Good skill definition.' },
      },
    });

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillReview('skills/test/SKILL.md', 70, WS);
    expect(result.skillPath).toBe('skills/test/SKILL.md');
    expect(result.score).toBe(85);
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('checks passed');
    expect(result.output).toContain('Good skill definition.');
  });

  test('passes the workspace and new review command to the CLI', async () => {
    const spy = makeMockSpawn(
      JSON.stringify({ review: { reviewScore: 90 }, judges: { content: {} } }),
      '',
      0,
    );
    // @ts-expect-error mock assignment
    Bun.spawn = spy;

    await runSkillReview('skills/test/SKILL.md', 0, WS);

    const argv = (spy.mock.calls[0] as unknown[])[0] as string[];
    expect(argv).toEqual([
      'tessl', 'review', 'run', 'quality', '--json',
      '--workspace', WS, '--threshold', '0', 'skills/test',
    ]);
  });

  test('omits --workspace when no workspace is configured', async () => {
    const spy = makeMockSpawn(
      JSON.stringify({ review: { reviewScore: 80 } }),
      '',
      0,
    );
    // @ts-expect-error mock assignment
    Bun.spawn = spy;

    await runSkillReview('skills/test/SKILL.md', 70);

    const argv = (spy.mock.calls[0] as unknown[])[0] as string[];
    expect(argv).not.toContain('--workspace');
    expect(argv).toEqual([
      'tessl', 'review', 'run', 'quality', '--json',
      '--threshold', '0', 'skills/test',
    ]);
  });

  test('surfaces validation checks that did not pass', async () => {
    const jsonOutput = JSON.stringify({
      review: { reviewScore: 40 },
      validation: {
        overallPassed: false,
        errorCount: 1,
        warningCount: 1,
        checks: [
          { name: 'body_present', status: 'passed', message: 'body is present' },
          { name: 'description_field', status: 'error', message: "'description' field is too short" },
          { name: 'relative_links', status: 'warning', message: '1 missing' },
        ],
      },
      judges: {
        content: {
          normalizedScore: 0.4,
          evaluation: {
            scores: { actionability: { score: 1, reasoning: 'abstract' } },
            suggestions: ['Add concrete commands'],
            overall_assessment: 'Needs work.',
          },
        },
      },
    });

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillReview('a/SKILL.md', 50, WS);
    expect(result.score).toBe(40);
    expect(result.passed).toBe(false);
    expect(result.validationIssues).toEqual([
      "❌ **description_field** — 'description' field is too short",
      '⚠️ **relative_links** — 1 missing',
    ]);
    expect(result.suggestions).toEqual(['Add concrete commands']);
    expect(result.overallAssessment).toBe('Needs work.');
    // Each check renders once: the failures above, the tally in the details.
    expect(result.output).toContain('1/3 checks passed.');
    expect(result.output).not.toContain('description_field');
  });

  test('a skill that fails validation reports its errors, not an action error', async () => {
    // A validation failure stops the judges running, so the payload carries no
    // score. The validation errors are the review, so they must reach the
    // author rather than being replaced by an action error.
    const jsonOutput = JSON.stringify({
      reviewRunId: 'rr_1',
      validation: {
        overallPassed: false,
        errorCount: 2,
        warningCount: 0,
        checks: [
          { name: 'body_present', status: 'passed', message: 'SKILL.md body is present' },
          {
            name: 'name_field',
            status: 'error',
            message: 'Must contain only lowercase letters, numbers, and hyphens',
          },
          {
            name: 'description_field',
            status: 'error',
            message: "'description' field is missing from frontmatter",
          },
        ],
      },
      review: { reviewScore: null },
    });

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillReview('a/SKILL.md', 70, WS);
    expect(result.error).toBeUndefined();
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.validationIssues).toEqual([
      '❌ **name_field** — Must contain only lowercase letters, numbers, and hyphens',
      "❌ **description_field** — 'description' field is missing from frontmatter",
    ]);
  });

  test('CLI failure (non-zero exit)', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('', 'Command not found', 1);

    const result = await runSkillReview('skills/test/SKILL.md', 50, WS);
    expect(result.score).toBe(-1);
    expect(result.passed).toBe(false);
    expect(result.error).toBe('Command not found');
  });

  test('CLI failure with threshold 0 still passes', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('', 'some error', 1);

    const result = await runSkillReview('skills/test/SKILL.md', 0, WS);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(-1);
  });

  test('auth failure with threshold 0 still fails', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('', '✘ 401 Unauthorized', 1);

    const result = await runSkillReview('skills/test/SKILL.md', 0, WS);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.error).toContain('401 Unauthorized');
  });

  test('detects login-required auth failures', () => {
    expect(isAuthErrorMessage('Skill review requires you to be logged in. Run tessl login to log in.')).toBe(true);
    expect(isAuthErrorMessage('✘ 401 Unauthorized')).toBe(true);
    expect(isAuthErrorMessage('some validation error')).toBe(false);
  });

  test('detects the auth failures Tessl Review reports', () => {
    // With no stored credentials at all.
    expect(
      isAuthErrorMessage(
        '✘ Please authenticate with Tessl to continue. Run `tessl login` to sign up or log in.',
      ),
    ).toBe(true);
    // With a token the API rejects.
    expect(
      isAuthErrorMessage('✘ Authentication failed. Please run `tessl login` to authenticate.'),
    ).toBe(true);
  });

  test('distinguishes workspace failures from score failures', () => {
    expect(isWorkspaceErrorMessage('Missing required flag: --workspace')).toBe(true);
    expect(isWorkspaceErrorMessage('✘ Workspace not found: typo-workspace')).toBe(true);
    expect(isWorkspaceErrorMessage('Review run failed')).toBe(false);
    expect(isSetupErrorMessage('✘ 401 Unauthorized')).toBe(true);
    expect(isSetupErrorMessage('Missing required flag: --workspace')).toBe(true);
    expect(isSetupErrorMessage('Skill has validation issues')).toBe(false);
  });

  test('an unresolvable workspace asks for the input and fails at threshold 0', async () => {
    // What the CLI prints with no workspace flag when the token can see more
    // than one and no tessl.json links a project.
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(
      '',
      'Missing required flag: --workspace\n\nUse --help to see usage',
      1,
    );

    const result = await runSkillReview('skills/test/SKILL.md', 0);
    // No review ran, so `fail-threshold: 0` must not let the check go green.
    expect(result.passed).toBe(false);
    expect(result.score).toBe(-1);
    expect(result.error).toContain('Missing required flag: --workspace');
    expect(result.error).toContain('Set the workspace input');
    expect(result.error).toContain('tessl workspace list');
  });

  test('a workspace that does not exist fails at threshold 0', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('', '✘ Workspace not found: typo-workspace', 1);

    const result = await runSkillReview('skills/test/SKILL.md', 0, 'typo-workspace');
    expect(result.passed).toBe(false);
    expect(result.error).toContain('Workspace not found');
    expect(result.error).toContain('Check the workspace input');
    // The set-it hint is for a missing workspace; this one is already set.
    expect(result.error).not.toContain('cannot choose for you');
  });

  test('malformed JSON output (unclosed brace)', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('{ broken json !!!', '', 0);

    const result = await runSkillReview('skills/test/SKILL.md', 50, WS);
    expect(result.score).toBe(-1);
    expect(result.error).toBe('Could not parse review output');
    expect(result.passed).toBe(false);
  });

  test('malformed JSON output (matched braces but invalid)', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('{ not: valid: json }', '', 0);

    const result = await runSkillReview('skills/test/SKILL.md', 50, WS);
    expect(result.score).toBe(-1);
    expect(result.error).toBe('Failed to parse JSON output');
    expect(result.passed).toBe(false);
  });

  test('no JSON in output', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('Some plain text output with no json', '', 0);

    const result = await runSkillReview('skills/test/SKILL.md', 50, WS);
    expect(result.score).toBe(-1);
    expect(result.error).toBe('Could not parse review output');
  });

  test('threshold pass/fail logic', async () => {
    const makeJson = (score: number) =>
      JSON.stringify({
        review: { reviewScore: score },
        judges: { content: { normalizedScore: score / 100, evaluation: 'test' } },
      });

    // Score 60% with threshold 50 → passed
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(makeJson(60), '', 0);
    const passing = await runSkillReview('a/SKILL.md', 50, WS);
    expect(passing.score).toBe(60);
    expect(passing.passed).toBe(true);

    // Score 40% with threshold 50 → failed
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(makeJson(40), '', 0);
    const failing = await runSkillReview('b/SKILL.md', 50, WS);
    expect(failing.score).toBe(40);
    expect(failing.passed).toBe(false);

    // Score 50% with threshold 50 → passed (>= threshold)
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(makeJson(50), '', 0);
    const boundary = await runSkillReview('c/SKILL.md', 50, WS);
    expect(boundary.score).toBe(50);
    expect(boundary.passed).toBe(true);

    // Any score with threshold 0 → always passed
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(makeJson(10), '', 0);
    const noThreshold = await runSkillReview('d/SKILL.md', 0, WS);
    expect(noThreshold.score).toBe(10);
    expect(noThreshold.passed).toBe(true);
  });

  test('a payload with no review score errors instead of reporting a judge score', async () => {
    // `review.reviewScore` is the review's own number; a judge's normalizedScore
    // measures one rubric and sits far from it, so it is not a stand-in.
    const jsonOutput = JSON.stringify({
      validation: { overallPassed: true, checks: [] },
      judges: { content: { normalizedScore: 0.2, evaluation: 'decent' } },
    });

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillReview('a/SKILL.md', 50, WS);
    expect(result.score).toBe(-1);
    expect(result.error).toBe('Review completed without a score');
    expect(result.passed).toBe(false);
  });

  test('formats structured evaluation object into markdown', async () => {
    const jsonOutput = JSON.stringify({
      review: { reviewScore: 50 },
      judges: {
        content: {
          normalizedScore: 0.5,
          evaluation: {
            scores: {
              conciseness: { score: 2, reasoning: 'Too verbose' },
              actionability: { score: 3, reasoning: 'Good examples' },
            },
            overall_assessment: 'Decent skill with room for improvement.',
            suggestions: ['Be more concise', 'Add validation steps'],
          },
        },
      },
    });

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillReview('a/SKILL.md', 0, WS);
    expect(result.output).toContain('| Dimension |');
    expect(result.output).toContain('**conciseness**');
    expect(result.output).toContain('**actionability**');
    expect(result.output).toContain('Too verbose');
    expect(result.output).toContain('**Suggestions:**');
    expect(result.output).toContain('- Be more concise');
    expect(result.output).not.toContain('[object Object]');
    // The assessment renders above the collapsed details, so the caller gets it
    // as a field rather than inside the output block.
    expect(result.overallAssessment).toBe('Decent skill with room for improvement.');
    expect(result.output).not.toContain('Decent skill with room for improvement.');
  });

  test('renders dimension scores against the declared rubric scale', async () => {
    const jsonOutput = JSON.stringify({
      review: { reviewScore: 90 },
      judges: {
        content: {
          normalizedScore: 0.9,
          scale: { min: 1, max: 5 },
          evaluation: {
            scores: {
              conciseness: { score: 5, reasoning: 'Tight' },
              actionability: { score: 4, reasoning: 'Good examples' },
            },
          },
        },
      },
    });

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillReview('a/SKILL.md', 0, WS);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('█████ 5/5');
    expect(result.output).toContain('████░ 4/5');
  });

  test('falls back to the 1-3 rubric when the judge omits a scale', async () => {
    const jsonOutput = JSON.stringify({
      review: { reviewScore: 60 },
      judges: {
        content: {
          evaluation: { scores: { conciseness: { score: 2, reasoning: 'Verbose' } } },
        },
      },
    });

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillReview('a/SKILL.md', 0, WS);
    expect(result.output).toContain('██░ 2/3');
  });

  test('a score above the declared scale renders without throwing', async () => {
    const jsonOutput = JSON.stringify({
      review: { reviewScore: 60 },
      judges: {
        content: {
          scale: { min: 1, max: 3 },
          evaluation: { scores: { conciseness: { score: 5, reasoning: 'Odd' } } },
        },
      },
    });

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillReview('a/SKILL.md', 0, WS);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('5/3');
  });

  test('renders the description judge alongside the content judge', async () => {
    const jsonOutput = JSON.stringify({
      review: { reviewScore: 70 },
      judges: {
        content: { evaluation: { scores: { conciseness: { score: 2, reasoning: 'Verbose' } } } },
        description: {
          scale: { min: 1, max: 5 },
          evaluation: { scores: { clarity: { score: 4, reasoning: 'Clear' } } },
        },
      },
    });

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillReview('a/SKILL.md', 0, WS);
    expect(result.output).toContain('### Review Details');
    expect(result.output).toContain('### Description Review');
    expect(result.output).toContain('████░ 4/5');
  });

  test('renders scores above the legacy 1-3 scale without throwing', async () => {
    const jsonOutput = JSON.stringify({
      review: { reviewScore: 90 },
      judges: {
        content: {
          normalizedScore: 0.9,
          evaluation: {
            scores: {
              actionability: { score: 5, reasoning: 'Fully executable.' },
              workflow_clarity: { score: 4, reasoning: 'Clear sequencing.' },
            },
          },
        },
      },
    });

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillReview('a/SKILL.md', 0, WS);
    expect(result.error).toBeUndefined();
    // No declared scale, so the denominator comes from the highest score in the
    // payload — the same one for every dimension, so a 4 is not full marks.
    expect(result.output).toContain('5/5');
    expect(result.output).toContain('4/5');
  });

  test('JSON with prefix and suffix text', async () => {
    const json = JSON.stringify({
      review: { reviewScore: 72 },
      judges: { content: { normalizedScore: 0.72, evaluation: 'decent' } },
    });
    const stdout = `Running review...\n${json}\nDone.`;

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(stdout, '', 0);

    const result = await runSkillReview('a/SKILL.md', 50, WS);
    expect(result.score).toBe(72);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. formatComment (tested via COMMENT_MARKER constant)
// ---------------------------------------------------------------------------

const COMMENT_MARKER = '<!-- tessl-skill-review -->';

// formatComment is not exported, so we test comment formatting indirectly
// through postOrUpdateComment's behavior and by checking the comment body
// passed to the mock.

describe('postOrUpdateComment', () => {
  const originalToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'fake-token';
    createCommentMock.mockClear();
    updateCommentMock.mockClear();
    listCommentsMock.mockClear();
    listCommentsMock.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    if (originalToken !== undefined) {
      process.env.GITHUB_TOKEN = originalToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  test('creates a new comment when none exists', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    await postOrUpdateComment(
      [{ skillPath: 'a/SKILL.md', passed: true, score: 80, output: 'ok' }],
      50,
    );

    expect(createCommentMock).toHaveBeenCalledTimes(1);
    expect(updateCommentMock).not.toHaveBeenCalled();

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(callArgs.owner).toBe('test-owner');
    expect(callArgs.repo).toBe('test-repo');
    expect(callArgs.issue_number).toBe(42);
    expect(callArgs.body).toContain(COMMENT_MARKER);
  });

  test('updates an existing comment when marker is found', async () => {
    listCommentsMock.mockResolvedValueOnce({
      data: [{ id: 999, body: `${COMMENT_MARKER}\nold comment` }],
    });

    await postOrUpdateComment(
      [{ skillPath: 'a/SKILL.md', passed: true, score: 90, output: 'ok' }],
      50,
    );

    expect(updateCommentMock).toHaveBeenCalledTimes(1);
    expect(createCommentMock).not.toHaveBeenCalled();

    const callArgs = (updateCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(callArgs.comment_id).toBe(999);
    expect(callArgs.body).toContain(COMMENT_MARKER);
  });

  test('comment body includes score and skill path', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    await postOrUpdateComment(
      [{ skillPath: 'skills/my-skill/SKILL.md', passed: true, score: 85, output: 'review output' }],
      50,
    );

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const body = callArgs.body as string;
    expect(body).toContain('`skills/my-skill/SKILL.md`');
    expect(body).toContain('review_score-85%25');
    expect(body).toContain('✅');
    expect(body).toContain('Tessl Skill Review');
  });

  test('comment body shows ❌ for failed skill', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    await postOrUpdateComment(
      [{ skillPath: 'a/SKILL.md', passed: false, score: 30, output: 'bad' }],
      50,
    );

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const body = callArgs.body as string;
    expect(body).toContain('❌');
    expect(body).toContain('review_score-30%25');
  });

  test('comment body shows ⚠️ for errored skill', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    await postOrUpdateComment(
      [{ skillPath: 'a/SKILL.md', passed: false, score: -1, output: '', error: 'CLI crashed' }],
      50,
    );

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const body = callArgs.body as string;
    expect(body).toContain('⚠️');
    expect(body).toContain('Error:');
  });

  test('no emoji when threshold is 0', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    await postOrUpdateComment(
      [{ skillPath: 'a/SKILL.md', passed: true, score: 50, output: 'ok' }],
      0,
    );

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const body = callArgs.body as string;
    expect(body).not.toContain('✅');
    expect(body).not.toContain('❌');
  });

  test('throws when GITHUB_TOKEN is missing', async () => {
    delete process.env.GITHUB_TOKEN;
    await expect(
      postOrUpdateComment(
        [{ skillPath: 'a/SKILL.md', passed: true, score: 80, output: 'ok' }],
        50,
      ),
    ).rejects.toThrow('GITHUB_TOKEN is required');
  });
});

// ---------------------------------------------------------------------------
// 6. writeJobSummary
// ---------------------------------------------------------------------------

describe('writeJobSummary', () => {
  const originalSummaryFile = process.env.GITHUB_STEP_SUMMARY;
  // `core.summary` resolves its destination once and reuses it, so every test
  // here shares one file and truncates it instead of taking a fresh path.
  const summaryFile = join(tmpdir(), `skill-review-summary-${process.pid}.md`);

  beforeEach(async () => {
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    await Bun.write(summaryFile, '');
  });

  afterAll(async () => {
    if (originalSummaryFile !== undefined) {
      process.env.GITHUB_STEP_SUMMARY = originalSummaryFile;
    } else {
      delete process.env.GITHUB_STEP_SUMMARY;
    }
    await rm(summaryFile, { force: true });
  });

  test('writes markdown lists so icons and bold names render', async () => {
    await writeJobSummary(
      [
        {
          skillPath: 'a/SKILL.md',
          passed: false,
          score: 0,
          output: 'ignored here',
          validationIssues: ["❌ **name_field** — Must be lowercase"],
          overallAssessment: 'Fails validation.',
        },
      ],
      70,
    );

    const written = await Bun.file(summaryFile).text();
    expect(written).toContain('<td>0%</td>');
    expect(written).toContain('❌ Fail');
    expect(written).toContain('> Fails validation.');
    expect(written).toContain('**Validation issues**');
    expect(written).toContain('- ❌ **name_field** — Must be lowercase');
    // A markdown list, not the <ul><li> markup that would show the asterisks.
    expect(written).not.toContain('<li>');
  });

  test('labels a passing skill\'s suggestions as suggestions', async () => {
    await writeJobSummary(
      [
        {
          skillPath: 'a/SKILL.md',
          passed: true,
          score: 85,
          output: 'ignored here',
          suggestions: ['Add a worked example'],
        },
      ],
      70,
    );

    const written = await Bun.file(summaryFile).text();
    expect(written).toContain('**Suggestions**');
    expect(written).toContain('- Add a worked example');
    expect(written).not.toContain('Validation issues');
    expect(written).not.toContain('Required changes');
  });

  test('reports a failed review as an error block', async () => {
    await writeJobSummary(
      [
        {
          skillPath: 'a/SKILL.md',
          passed: false,
          score: -1,
          output: '',
          error: 'Missing required flag: --workspace',
        },
      ],
      0,
    );

    const written = await Bun.file(summaryFile).text();
    expect(written).toContain('<td>—</td>');
    expect(written).toContain('⚠️ Error');
    expect(written).toContain('**Error**');
    expect(written).toContain('- Missing required flag: --workspace');
  });

  test('skips a clean skill entirely', async () => {
    await writeJobSummary(
      [{ skillPath: 'a/SKILL.md', passed: true, score: 100, output: 'ignored' }],
      70,
    );

    const written = await Bun.file(summaryFile).text();
    expect(written).toContain('<td>100%</td>');
    expect(written).not.toContain('<h3>');
  });
});
