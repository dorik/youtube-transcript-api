import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors';
import { buildWatchUrl, extractVideoId } from './youtubeUrl';

const VALID_ID = 'dQw4w9WgXcQ';

describe('extractVideoId', () => {
  it('returns a bare 11-char id unchanged', () => {
    expect(extractVideoId(VALID_ID)).toBe(VALID_ID);
  });

  it('trims surrounding whitespace before matching', () => {
    expect(extractVideoId(`  ${VALID_ID}  `)).toBe(VALID_ID);
  });

  it.each([
    [`https://www.youtube.com/watch?v=${VALID_ID}`, 'standard watch URL'],
    [`https://youtube.com/watch?v=${VALID_ID}`, 'no-www watch URL'],
    [`https://m.youtube.com/watch?v=${VALID_ID}`, 'mobile watch URL'],
    [`https://youtu.be/${VALID_ID}`, 'short youtu.be URL'],
    [`https://www.youtube.com/embed/${VALID_ID}`, 'embed URL'],
    [`https://www.youtube.com/shorts/${VALID_ID}`, 'shorts URL'],
    [`https://www.youtube.com/v/${VALID_ID}`, 'legacy /v/ URL'],
    [`https://www.youtube-nocookie.com/watch?v=${VALID_ID}`, 'nocookie watch URL'],
  ])('extracts the id from %s (%s)', (url) => {
    expect(extractVideoId(url)).toBe(VALID_ID);
  });

  it('extracts the id when other query params come first', () => {
    expect(
      extractVideoId(`https://www.youtube.com/watch?feature=share&v=${VALID_ID}&t=42`),
    ).toBe(VALID_ID);
  });

  it('extracts the id when followed by extra query params', () => {
    expect(extractVideoId(`https://www.youtube.com/watch?v=${VALID_ID}&t=10s`)).toBe(VALID_ID);
  });

  it('extracts the id from a youtu.be link with a query string', () => {
    expect(extractVideoId(`https://youtu.be/${VALID_ID}?t=30`)).toBe(VALID_ID);
  });

  it('throws ValidationError when the input has no recognisable id', () => {
    expect(() => extractVideoId('https://example.com/foo')).toThrow(ValidationError);
  });

  it('throws ValidationError on an id of the wrong length', () => {
    // 10 chars — one short of the YouTube id length
    expect(() => extractVideoId('shortidxxx')).toThrow(ValidationError);
  });

  it('throws ValidationError for an empty string', () => {
    expect(() => extractVideoId('')).toThrow(ValidationError);
  });

  it('attaches the offending url to ValidationError details', () => {
    try {
      extractVideoId('not-a-url');
      throw new Error('expected extractVideoId to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details).toEqual({ url: 'not-a-url' });
    }
  });
});

describe('buildWatchUrl', () => {
  it('builds a canonical watch URL', () => {
    expect(buildWatchUrl(VALID_ID)).toBe(`https://www.youtube.com/watch?v=${VALID_ID}`);
  });
});
