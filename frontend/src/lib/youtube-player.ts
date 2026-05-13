'use client';

/**
 * Minimal wrapper around YouTube's IFrame API.
 *
 * Why we accept an HTMLElement parent (instead of an element id):
 * - YT.Player REPLACES the element you give it with an `<iframe>`.
 * - If we hand it the same DOM node React renders, React's reconciler will
 *   notice the type change (div → iframe) on the next re-render and stomp
 *   the iframe. Symptom: a black box where the player should be.
 * - So we pass a freshly-created child div that React never sees in JSX.
 *   The wrapper div stays React-owned and stable; the child belongs to the
 *   SDK and is destroyed on unmount.
 */

type YTPlayer = {
  destroy: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
};

declare global {
  interface Window {
    YT?: { Player: new (id: string | HTMLElement, opts: unknown) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadYouTubeScript(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('YouTube IFrame API unavailable on server'));
  }
  if (window.YT?.Player) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve) => {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;

    // The SDK invokes window.onYouTubeIframeAPIReady once it's loaded.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    document.head.appendChild(tag);
  });
  return scriptPromise;
}

export interface PlayerHandle {
  seekTo: (seconds: number) => void;
  destroy: () => void;
}

/**
 * Codes the YouTube IFrame API uses for `onError`:
 *
 *   2   - invalid videoId / parameter
 *   5   - HTML5 player problem (very rare)
 *   100 - video removed / private
 *   101 - owner disabled embedding on this video
 *   150 - same as 101 (different player flavour)
 *
 * Consumers care about "the player can't play this" (any of the above) more
 * than the specific code; we hand the code through anyway so the UI can
 * tailor the message ("removed" vs "embed disabled" etc.) if it wants.
 */
export type PlayerErrorCode = 2 | 5 | 100 | 101 | 150 | number;

export interface PlayerErrorEvent {
  code: PlayerErrorCode;
  /** True for 101 / 150 — owner explicitly disabled embedding. */
  embedDisabled: boolean;
  /** True for 100 — video removed or made private. */
  removed: boolean;
}

export interface MountPlayerOptions {
  /**
   * Invoked when the YouTube SDK fires `onError`. Most common cause we hit
   * in production is 101/150 — the channel owner disabled embedding (common
   * for music-label channels). The viewer uses this to swap the dead iframe
   * for a thumbnail + "Watch on YouTube" CTA.
   *
   * Fires AFTER `onReady` so the promise has already resolved; the iframe
   * is mounted but will show YouTube's own error UI ("Video unavailable…")
   * until the consumer replaces it.
   */
  onError?: (event: PlayerErrorEvent) => void;
}

/**
 * Mount a YouTube player into `wrapper` for `videoId`.
 *
 * `onTime` is invoked roughly 4×/second with the current playback time so
 * the consumer can highlight the active transcript segment. The handle
 * exposes `seekTo` for click-to-jump. On `destroy()` the iframe and the
 * SDK-owned child div are removed; the React-owned wrapper is left intact.
 */
export async function mountPlayer(
  wrapper: HTMLElement,
  videoId: string,
  onTime: (seconds: number) => void,
  options: MountPlayerOptions = {},
): Promise<PlayerHandle> {
  await loadYouTubeScript();
  const YT = window.YT!;

  // Reset wrapper so re-mounts (StrictMode double-effect, video changes)
  // don't accumulate orphaned iframes.
  wrapper.replaceChildren();

  const target = document.createElement('div');
  target.style.width = '100%';
  target.style.height = '100%';
  wrapper.appendChild(target);

  let player: YTPlayer | null = null;
  await new Promise<void>((resolve) => {
    player = new YT.Player(target, {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        // Some embeds 401 without an explicit origin in dev.
        origin: typeof window !== 'undefined' ? window.location.origin : undefined,
      },
      events: {
        onReady: () => resolve(),
        onError: (e: { data: number }) => {
          const code = e?.data;
          if (typeof code !== 'number') return;
          options.onError?.({
            code,
            embedDisabled: code === 101 || code === 150,
            removed: code === 100,
          });
        },
      },
    });
  });

  // Polling is the simplest, most reliable way to highlight segments —
  // YouTube's IFrame state events don't include playback time.
  const tickHandle = window.setInterval(() => {
    try {
      const t = player!.getCurrentTime();
      if (typeof t === 'number' && !Number.isNaN(t)) onTime(t);
    } catch {
      /* player not ready */
    }
  }, 250);

  return {
    seekTo: (seconds: number) => {
      try {
        player?.seekTo(seconds, true);
        player?.playVideo();
      } catch {
        /* ignore */
      }
    },
    destroy: () => {
      clearInterval(tickHandle);
      try {
        player?.destroy();
      } catch {
        /* ignore */
      }
      // YT.destroy may leave the (replaced) iframe behind in some versions;
      // make sure the wrapper is empty.
      wrapper.replaceChildren();
    },
  };
}
