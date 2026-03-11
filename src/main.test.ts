import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { SkillReviewResult } from './skill-review.ts';

// ---------------------------------------------------------------------------
// Mock @actions/core and @actions/github at module level
// ---------------------------------------------------------------------------

mock.module('@actions/core', () => ({
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
const { runSkillReview, extractJson } = await import('./skill-review.ts');
const { postOrUpdateComment } = await import('./comment.ts');
const { parseThreshold } = await import('./main.ts');

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

  test('successful review with JSON output', async () => {
    const jsonOutput = JSON.stringify({
      contentJudge: {
        normalizedScore: 0.85,
        evaluation: 'Good skill definition.',
      },
      validation: { output: 'All checks passed.' },
    });

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillReview('skills/test/SKILL.md', 70);
    expect(result.skillPath).toBe('skills/test/SKILL.md');
    expect(result.score).toBe(85);
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('All checks passed.');
    expect(result.output).toContain('Good skill definition.');
  });

  test('CLI failure (non-zero exit)', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('', 'Command not found', 1);

    const result = await runSkillReview('skills/test/SKILL.md', 50);
    expect(result.score).toBe(-1);
    expect(result.passed).toBe(false);
    expect(result.error).toBe('Command not found');
  });

  test('CLI failure with threshold 0 still passes', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('', 'some error', 1);

    const result = await runSkillReview('skills/test/SKILL.md', 0);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(-1);
  });

  test('malformed JSON output (unclosed brace)', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('{ broken json !!!', '', 0);

    const result = await runSkillReview('skills/test/SKILL.md', 50);
    expect(result.score).toBe(-1);
    expect(result.error).toBe('Could not parse review output');
    expect(result.passed).toBe(false);
  });

  test('malformed JSON output (matched braces but invalid)', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('{ not: valid: json }', '', 0);

    const result = await runSkillReview('skills/test/SKILL.md', 50);
    expect(result.score).toBe(-1);
    expect(result.error).toBe('Failed to parse JSON output');
    expect(result.passed).toBe(false);
  });

  test('no JSON in output', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('Some plain text output with no json', '', 0);

    const result = await runSkillReview('skills/test/SKILL.md', 50);
    expect(result.score).toBe(-1);
    expect(result.error).toBe('Could not parse review output');
  });

  test('threshold pass/fail logic', async () => {
    const makeJson = (score: number) =>
      JSON.stringify({
        contentJudge: { normalizedScore: score, evaluation: 'test' },
      });

    // Score 60% with threshold 50 → passed
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(makeJson(0.6), '', 0);
    const passing = await runSkillReview('a/SKILL.md', 50);
    expect(passing.score).toBe(60);
    expect(passing.passed).toBe(true);

    // Score 40% with threshold 50 → failed
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(makeJson(0.4), '', 0);
    const failing = await runSkillReview('b/SKILL.md', 50);
    expect(failing.score).toBe(40);
    expect(failing.passed).toBe(false);

    // Score 50% with threshold 50 → passed (>= threshold)
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(makeJson(0.5), '', 0);
    const boundary = await runSkillReview('c/SKILL.md', 50);
    expect(boundary.score).toBe(50);
    expect(boundary.passed).toBe(true);

    // Any score with threshold 0 → always passed
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(makeJson(0.1), '', 0);
    const noThreshold = await runSkillReview('d/SKILL.md', 0);
    expect(noThreshold.score).toBe(10);
    expect(noThreshold.passed).toBe(true);
  });

  test('formats structured evaluation object into markdown', async () => {
    const jsonOutput = JSON.stringify({
      contentJudge: {
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
    });

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillReview('a/SKILL.md', 0);
    expect(result.output).toContain('| Dimension |');
    expect(result.output).toContain('**conciseness**');
    expect(result.output).toContain('**actionability**');
    expect(result.output).toContain('Too verbose');
    expect(result.output).toContain('**Overall:**');
    expect(result.output).toContain('Decent skill with room for improvement.');
    expect(result.output).toContain('**Suggestions:**');
    expect(result.output).toContain('- Be more concise');
    expect(result.output).not.toContain('[object Object]');
  });

  test('JSON with prefix and suffix text', async () => {
    const json = JSON.stringify({
      contentJudge: { normalizedScore: 0.72, evaluation: 'decent' },
    });
    const stdout = `Running review...\n${json}\nDone.`;

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(stdout, '', 0);

    const result = await runSkillReview('a/SKILL.md', 50);
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
    expect(body).toContain('Score: 85%');
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
    expect(body).toContain('Score: 30%');
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
    expect(body).toContain('Score: N/A');
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
