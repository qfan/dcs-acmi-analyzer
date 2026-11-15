import { describe, expect, it } from "vitest";
import { BGM_TRACKS, pickRandomTrackIndex } from "../src/game/ui/bgm.ts";

describe("game BGM playlist", () => {
  it("discovers audio files from sound/bgm/ at build time", () => {
    expect(BGM_TRACKS.length).toBeGreaterThan(0);
    for (const url of BGM_TRACKS) {
      expect(url).toMatch(/\.mp3(\?|$)/);
    }
  });

  it("pickRandomTrackIndex handles empty and single-track playlists", () => {
    expect(pickRandomTrackIndex(0, null)).toBe(-1);
    expect(pickRandomTrackIndex(1, null)).toBe(0);
    expect(pickRandomTrackIndex(1, 0)).toBe(0);
  });

  it("pickRandomTrackIndex never repeats the current track when count > 1", () => {
    const count = 5;
    for (let current = 0; current < count; current++) {
      for (let step = 0; step < 20; step++) {
        const r = step / 20;
        const next = pickRandomTrackIndex(count, current, () => r);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThan(count);
        expect(next).not.toBe(current);
      }
    }
  });
});
