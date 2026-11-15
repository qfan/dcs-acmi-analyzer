/**
 * Build-time discovered background music playlist for BVR Trainer.
 * Vite scans `sound/bgm/` during dev and build, so adding or removing audio
 * files in `sound/bgm/` updates the runtime playlist automatically.
 */
const bgmModules = import.meta.glob<string>("../../../sound/bgm/*.{mp3,ogg,wav,m4a,flac,aac,opus,webm}", {
  eager: true,
  query: "?url",
  import: "default",
});

export const BGM_TRACKS: readonly string[] = Object.entries(bgmModules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => url);

const DEFAULT_VOLUME = 0.35;

/** Pick a random track index in `[0, count)`, avoiding `currentIndex` when `count > 1`. */
export function pickRandomTrackIndex(
  count: number,
  currentIndex: number | null,
  rng: () => number = Math.random,
): number {
  if (count <= 0) return -1;
  if (count === 1) return 0;
  const hasCurrent = currentIndex !== null && currentIndex >= 0 && currentIndex < count;
  if (!hasCurrent) return Math.floor(rng() * count);
  const pick = Math.floor(rng() * (count - 1));
  return pick >= currentIndex ? pick + 1 : pick;
}

export interface BgmPlayer {
  readonly hasTracks: boolean;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

/**
 * Lazy, infinite-shuffle BGM player backed by a single HTMLAudioElement.
 * Nothing is fetched while disabled; once enabled, tracks stream on demand
 * and advance randomly forever until disabled or disposed.
 */
export function createBgmPlayer(tracks: readonly string[] = BGM_TRACKS): BgmPlayer {
  let audio: HTMLAudioElement | null = null;
  let enabled = false;
  let currentIndex: number | null = null;
  let consecutiveErrors = 0;

  const playNextRandom = () => {
    if (!enabled || tracks.length === 0) return;
    if (!audio) {
      audio = new Audio();
      audio.volume = DEFAULT_VOLUME;
      audio.preload = "auto";
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("playing", onPlaying);
      audio.addEventListener("error", onError);
    }
    const nextIdx = pickRandomTrackIndex(tracks.length, currentIndex);
    const url = tracks[nextIdx];
    if (url === undefined) return;
    currentIndex = nextIdx;
    audio.src = url;
    audio.play().catch(() => {
      // Ignore autoplay/abort rejections (e.g. rapid toggle or browser policy).
    });
  };

  const onEnded = () => {
    playNextRandom();
  };

  const onPlaying = () => {
    consecutiveErrors = 0;
  };

  const onError = () => {
    if (!enabled) return;
    consecutiveErrors += 1;
    if (consecutiveErrors < tracks.length) {
      playNextRandom();
    }
  };

  return {
    hasTracks: tracks.length > 0,
    setEnabled(next: boolean) {
      enabled = next;
      if (!next) {
        audio?.pause();
        return;
      }
      if (tracks.length === 0) return;
      consecutiveErrors = 0;
      if (audio?.src && !audio.ended && !audio.error) {
        audio.play().catch(() => {
          // Ignore autoplay/abort rejections.
        });
      } else {
        playNextRandom();
      }
    },
    dispose() {
      enabled = false;
      if (!audio) return;
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("error", onError);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audio = null;
    },
  };
}
