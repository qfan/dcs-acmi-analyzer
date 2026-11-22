/**
 * Where a recording came from. Real sim recordings (DCS through Tacview or DCS2ACMI) and fights
 * recorded by this project's BVR Trainer game share the ACMI format, but the game's flight and
 * missile models are not DCS's: mixing them would pollute any DCS statistics.
 *
 * The game writes `DataSource=BVR Trainer <version>` and `DataRecorder=BVR Trainer <version>`.
 * Files from before versioning carry the bare name.
 */

export const BVR_TRAINER_NAME = "BVR Trainer";
/** Version of the game's recording format and sim model, written into every exported .acmi. */
export const BVR_TRAINER_VERSION = "1.1.0";
/** `DataSource` / `DataRecorder` value the game writes. */
export const BVR_TRAINER_SOURCE = `${BVR_TRAINER_NAME} ${BVR_TRAINER_VERSION}`;

/** "sim": a real simulator recording (DCS or unknown); "bvr-trainer": recorded by our game. */
export type RecordingSourceKind = "sim" | "bvr-trainer";

export interface RecordingSource {
  kind: RecordingSourceKind;
  /** Game version for "bvr-trainer" files (null when written before versioning); null for "sim". */
  version: string | null;
}

const GAME_RE = /^\s*BVR Trainer(?:\s+v?(\d+(?:\.\d+)*))?\b/i;

export function detectRecordingSource(globals: {
  DataSource?: string;
  DataRecorder?: string;
}): RecordingSource {
  for (const v of [globals.DataSource, globals.DataRecorder]) {
    const m = v ? GAME_RE.exec(v) : null;
    if (m) return { kind: "bvr-trainer", version: m[1] ?? null };
  }
  return { kind: "sim", version: null };
}

/** Display / cohort label for a game recording, e.g. "BVR Trainer 1.0.0" or "BVR Trainer (pre-1.0)". */
export function bvrTrainerLabel(version: string | null): string {
  return version ? `${BVR_TRAINER_NAME} ${version}` : `${BVR_TRAINER_NAME} (pre-1.0)`;
}
