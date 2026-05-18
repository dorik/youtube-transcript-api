import { describe, expect, it } from 'vitest';
import {
  isSupportedLanguageCode,
  normalizeLanguageCode,
} from './languageCodes';

describe('normalizeLanguageCode', () => {
  it('passes through canonical codes unchanged', () => {
    expect(normalizeLanguageCode('en')).toBe('en');
    expect(normalizeLanguageCode('bn')).toBe('bn');
    expect(normalizeLanguageCode('zh-TW')).toBe('zh-TW');
    expect(normalizeLanguageCode('pt-BR')).toBe('pt-BR');
  });

  it('maps Whisper full-name output to ISO codes', () => {
    // The core bug this util fixes: Whisper returns "bengali", everything
    // else uses "bn".
    expect(normalizeLanguageCode('english')).toBe('en');
    expect(normalizeLanguageCode('bengali')).toBe('bn');
    expect(normalizeLanguageCode('spanish')).toBe('es');
    expect(normalizeLanguageCode('chinese')).toBe('zh');
    // Capitalized name (defensive — Whisper returns lowercase, but APIs
    // sometimes title-case for display).
    expect(normalizeLanguageCode('English')).toBe('en');
  });

  it('strips YouTube original/auto suffixes', () => {
    expect(normalizeLanguageCode('en-orig')).toBe('en');
    expect(normalizeLanguageCode('en-auto')).toBe('en');
    expect(normalizeLanguageCode('bn-ORIG')).toBe('bn');
  });

  it('re-cases region tags', () => {
    expect(normalizeLanguageCode('zh-tw')).toBe('zh-TW');
    expect(normalizeLanguageCode('PT-br')).toBe('pt-BR');
  });

  it('falls back to base code when region variant is unsupported', () => {
    // We list zh-TW but not zh-CN — collapsing to the base is the right
    // default so the comparison still succeeds.
    expect(normalizeLanguageCode('en-US')).toBe('en');
    expect(normalizeLanguageCode('en-GB')).toBe('en');
  });

  it('leaves sentinels untouched', () => {
    expect(normalizeLanguageCode('auto')).toBe('auto');
    expect(normalizeLanguageCode('none')).toBe('none');
  });

  it('handles empty / missing input', () => {
    expect(normalizeLanguageCode('')).toBe('');
    expect(normalizeLanguageCode('   ')).toBe('');
    expect(normalizeLanguageCode(null)).toBe('');
    expect(normalizeLanguageCode(undefined)).toBe('');
  });

  it('passes unknowns through lowercased so identical inputs stay equal', () => {
    expect(normalizeLanguageCode('klingon')).toBe('klingon');
    expect(normalizeLanguageCode('KLINGON')).toBe('klingon');
    // Two callers that both send "klingon" still compare equal.
    expect(normalizeLanguageCode('Klingon')).toBe(
      normalizeLanguageCode('KLINGON'),
    );
  });
});

describe('isSupportedLanguageCode', () => {
  it('accepts canonical codes and their normalizable forms', () => {
    expect(isSupportedLanguageCode('en')).toBe(true);
    expect(isSupportedLanguageCode('EN')).toBe(true);
    expect(isSupportedLanguageCode('english')).toBe(true);
    expect(isSupportedLanguageCode('en-US')).toBe(true); // collapses to en
    expect(isSupportedLanguageCode('zh-TW')).toBe(true);
  });

  it('rejects unsupported codes — the bug: zzzz used to flow through', () => {
    expect(isSupportedLanguageCode('zzzz')).toBe(false);
    expect(isSupportedLanguageCode('klingon')).toBe(false);
  });

  it('rejects sentinels — callers allow auto/none explicitly where valid', () => {
    expect(isSupportedLanguageCode('auto')).toBe(false);
    expect(isSupportedLanguageCode('none')).toBe(false);
  });

  it('rejects empty / missing input', () => {
    expect(isSupportedLanguageCode('')).toBe(false);
    expect(isSupportedLanguageCode(null)).toBe(false);
    expect(isSupportedLanguageCode(undefined)).toBe(false);
  });
});
