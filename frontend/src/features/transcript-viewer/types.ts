import type { TranscriptResponse } from '@/lib/api';

export interface TranscriptViewerProps {
  data: TranscriptResponse;
  /** Called when the user picks a different language (refetch). */
  onLanguageChange?: (lang: string) => void;
  /**
   * Called when the user picks a translation target from inside the viewer.
   * `target` is an ISO 639-1 code or `null` to remove translation.
   * The page should re-fetch with the new param and pass fresh `data` back.
   */
  onTranslateTargetChange?: (target: string | null) => void;
  /** True while the page is re-fetching (e.g. after a translate change). */
  isRefetching?: boolean;
}
