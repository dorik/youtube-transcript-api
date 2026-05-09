'use client';

/**
 * User-tweakable subtitle overlay settings (font size, colors, word-by-word
 * highlighting, line count, offset). Persisted to localStorage so the user
 * doesn't reset their preferences on refresh.
 */

// Bumped from v1 → v2 because the offset semantics changed (positive
// offsetMs is now "subtitles appear later", matching VLC/SRT convention).
// Old stored values would behave inverted under the new formula, so we
// just discard them on first load after the bump.
const STORAGE_KEY = 'yt-subtitle-settings-v2';

export const FONT_SIZES = [14, 16, 18, 20, 24, 28, 32] as const;
export type FontSize = (typeof FONT_SIZES)[number];

/**
 * Each color is { id, label, value }. We store the id (stable token) and
 * resolve to a CSS color when rendering — that way swapping colors later
 * doesn't break stored settings.
 */
export const TEXT_COLORS: ReadonlyArray<{ id: string; label: string; value: string }> = [
  { id: 'white', label: 'White', value: '#ffffff' },
  { id: 'yellow', label: 'Yellow', value: '#ffeb3b' },
  { id: 'cyan', label: 'Cyan', value: '#22d3ee' },
  { id: 'green', label: 'Green', value: '#4ade80' },
  { id: 'magenta', label: 'Magenta', value: '#e879f9' },
];

export const HIGHLIGHT_COLORS: ReadonlyArray<{ id: string; label: string; value: string }> = [
  { id: 'yellow', label: 'Yellow', value: '#facc15' },
  { id: 'cyan', label: 'Cyan', value: '#22d3ee' },
  { id: 'green', label: 'Green', value: '#4ade80' },
  { id: 'orange', label: 'Orange', value: '#fb923c' },
  { id: 'pink', label: 'Pink', value: '#f472b6' },
];

export interface SubtitleSettings {
  fontSize: FontSize;
  textColorId: string;
  highlightColorId: string;
  background: boolean;
  wordByWord: boolean;
  /** Number of segments shown simultaneously. */
  lines: 1 | 2;
  /** Time offset in milliseconds. Positive = subtitles shown later. */
  offsetMs: number;
}

export const DEFAULT_SUBTITLE_SETTINGS: SubtitleSettings = {
  fontSize: 18,
  textColorId: 'white',
  highlightColorId: 'yellow',
  background: true,
  wordByWord: true,
  lines: 1,
  offsetMs: 0,
};

export function resolveTextColor(id: string): string {
  return TEXT_COLORS.find((c) => c.id === id)?.value ?? '#ffffff';
}

export function resolveHighlightColor(id: string): string {
  return HIGHLIGHT_COLORS.find((c) => c.id === id)?.value ?? '#facc15';
}

export function loadSubtitleSettings(): SubtitleSettings {
  if (typeof window === 'undefined') return DEFAULT_SUBTITLE_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SUBTITLE_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<SubtitleSettings>;
    return {
      ...DEFAULT_SUBTITLE_SETTINGS,
      ...parsed,
      // Validate enum-ish fields so a stale or malformed entry can't crash
      // the renderer.
      fontSize: (FONT_SIZES as readonly number[]).includes(parsed.fontSize ?? -1)
        ? (parsed.fontSize as FontSize)
        : DEFAULT_SUBTITLE_SETTINGS.fontSize,
      lines: parsed.lines === 2 ? 2 : 1,
    };
  } catch {
    return DEFAULT_SUBTITLE_SETTINGS;
  }
}

export function saveSubtitleSettings(settings: SubtitleSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* quota / private mode — fail silently */
  }
}
