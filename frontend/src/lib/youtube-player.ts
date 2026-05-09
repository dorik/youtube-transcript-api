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
      events: { onReady: () => resolve() },
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
