import { describe, it, expect, vi, beforeEach } from 'vitest';

// cacheService talks to Postgres (pool) and Redis. Mock both modules so the
// tests assert the SQL/Redis operations issued, with no real connections.
const queryMock = vi.hoisted(() => vi.fn());

vi.mock('../db/pool', () => ({
  pool: {
    query: (...args: unknown[]) => queryMock(...args),
  },
  // invalidateCacheTables() runs inside withTransaction; the fake just calls
  // the callback with a client whose query() is the same recording mock.
  withTransaction: async (fn: (client: unknown) => unknown) =>
    fn({ query: (...args: unknown[]) => queryMock(...args) }),
}));

const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  setex: vi.fn(),
  scan: vi.fn(),
  del: vi.fn(),
  flushall: vi.fn(),
  dbsize: vi.fn(),
}));
vi.mock('../cache/redis', () => ({ redis: redisMock }));

import { setCached } from './cacheService';

const sqlsFrom = (mock: typeof queryMock): string[] =>
  mock.mock.calls.map((c) => String(c[0]));

describe('setCached', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue({ rowCount: 1, rows: [] });
    redisMock.setex.mockResolvedValue('OK');
  });

  it('uses COALESCE so a null title/channel cannot overwrite stored metadata', async () => {
    await setCached({
      videoId: 'v1',
      language: 'en',
      title: null,
      channel: null,
      durationSeconds: 12,
      source: 'native_captions',
      transcript: 'hello',
      segments: [{ start: 0, duration: 1, text: 'hello' }],
      cachedAt: new Date().toISOString(),
    });
    const insertCall = queryMock.mock.calls.find((c) =>
      /INSERT INTO cached_transcripts/i.test(String(c[0])),
    );
    expect(insertCall).toBeDefined();
    const insertSql = String(insertCall![0]);
    expect(insertSql).toMatch(/\btitle\s*=\s*COALESCE\(EXCLUDED\.title,\s*cached_transcripts\.title\)/i);
    expect(insertSql).toMatch(/\bchannel\s*=\s*COALESCE\(EXCLUDED\.channel,\s*cached_transcripts\.channel\)/i);
    const params = insertCall![1] as unknown[];
    expect(params[2]).toBeNull(); // $3 = title
    expect(params[3]).toBeNull(); // $4 = channel
  });
});

import { clearCache, flushAllCache, getCached } from './cacheService';

describe('cache flush preserves metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.flushall.mockResolvedValue('OK');
    redisMock.dbsize.mockResolvedValue(0);
    redisMock.scan.mockResolvedValue(['0', []]); // empty keyspace
    queryMock.mockImplementation((sql: string) => {
      if (/SELECT COUNT/i.test(sql)) return Promise.resolve({ rows: [{ count: '0' }] });
      if (/UPDATE cached_transcripts/i.test(sql)) return Promise.resolve({ rowCount: 3, rows: [] });
      return Promise.resolve({ rowCount: 0, rows: [] });
    });
  });

  it('flushAllCache UPDATEs cached_transcripts instead of dropping it', async () => {
    await flushAllCache();
    const sqls = sqlsFrom(queryMock);
    expect(sqls.some((s) => /UPDATE cached_transcripts/i.test(s))).toBe(true);
    expect(sqls.some((s) => /TRUNCATE\s+cached_transcripts/i.test(s))).toBe(false);
    expect(sqls.some((s) => /DELETE FROM cached_transcripts/i.test(s))).toBe(false);
  });

  it('the flush UPDATE never mutates the metadata columns', async () => {
    await flushAllCache();
    const updateSql = sqlsFrom(queryMock).find((s) =>
      /UPDATE cached_transcripts/i.test(s),
    )!;
    expect(updateSql).toBeDefined();
    expect(updateSql).not.toMatch(/\btitle\b/);
    expect(updateSql).not.toMatch(/\bchannel\b/);
    expect(updateSql).not.toMatch(/duration_seconds/);
  });

  it('global clearCache() also UPDATEs rather than truncates cached_transcripts', async () => {
    await clearCache();
    const sqls = sqlsFrom(queryMock);
    expect(sqls.some((s) => /UPDATE cached_transcripts/i.test(s))).toBe(true);
    expect(sqls.some((s) => /TRUNCATE\s+cached_transcripts/i.test(s))).toBe(false);
  });

  it('per-video clearCache(videoId) invalidates only the target video and keeps metadata', async () => {
    await clearCache('abc12345678');
    const updateCall = queryMock.mock.calls.find((c) =>
      /UPDATE cached_transcripts/i.test(String(c[0])),
    );
    expect(updateCall).toBeDefined();
    expect(String(updateCall![0])).toMatch(/WHERE video_id = \$1/i);
    expect(updateCall![1]).toEqual(['abc12345678']);
    expect(String(updateCall![0])).not.toMatch(/\btitle\b/);
    const sqls = sqlsFrom(queryMock);
    expect(sqls.some((s) => /DELETE FROM cached_transcripts/i.test(s))).toBe(false);
    expect(sqls.some((s) => /DELETE FROM translated_transcripts/i.test(s))).toBe(true);
  });
});

describe('getCached', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.get.mockResolvedValue(null); // Redis miss -> fall through to Postgres
  });

  it('preserves a null title/channel from the DB row instead of coercing to a placeholder', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (/SELECT[\s\S]*FROM cached_transcripts/i.test(sql)) {
        return Promise.resolve({
          rows: [
            {
              video_id: 'v1',
              language: 'en',
              title: null,
              channel: null,
              duration_seconds: 120,
              source: 'native_captions',
              transcript_text: 'hi',
              segments: [{ start: 0, duration: 1, text: 'hi' }],
              first_cached_at: new Date(),
            },
          ],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await getCached('v1', 'en');
    expect(result).not.toBeNull();
    expect(result!.title).toBeNull();
    expect(result!.channel).toBeNull();
  });
});
