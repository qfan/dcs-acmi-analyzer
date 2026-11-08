import type { ContainerInfo } from "./container.ts";
import type { AcmiEvent, ParseStats, ParseWarning, Recording, WarningKind } from "./model.ts";

/** Lightweight, clone-friendly view of a Recording for the UI (no telemetry arrays). */
export interface ObjectSummary {
  uid: number;
  id: string;
  name: string;
  type: string;
  tags: string[];
  pilot: string;
  group: string;
  coalition: string;
  color: string;
  country: string;
  createdAt: number;
  removedAt: number | null;
  destroyedAt: number | null;
  samples: number;
  previousUid: number | null;
  reappearGap: number | null;
}

export interface RecordingSummary {
  container: ContainerInfo;
  fileType: string | null;
  fileVersion: string | null;
  globals: Record<string, string>;
  referenceTime: string | null;
  timeStart: number;
  timeEnd: number;
  objects: ObjectSummary[];
  events: AcmiEvent[];
  truncated: boolean;
  warnings: ParseWarning[];
  warningCounts: Partial<Record<WarningKind, number>>;
  stats: ParseStats;
}

export function summarize(r: Recording): RecordingSummary {
  return {
    container: r.container,
    fileType: r.fileType,
    fileVersion: r.fileVersion,
    globals: r.globals,
    referenceTime: r.referenceTime,
    timeStart: r.timeStart,
    timeEnd: r.timeEnd,
    objects: r.objects.map((o) => ({
      uid: o.uid,
      id: o.id,
      name: o.name,
      type: o.type,
      tags: o.tags,
      pilot: o.pilot,
      group: o.group,
      coalition: o.coalition,
      color: o.color,
      country: o.country,
      createdAt: o.createdAt,
      removedAt: o.removedAt,
      destroyedAt: o.destroyedAt,
      samples: o.transform?.times.length ?? 0,
      previousUid: o.previousUid,
      reappearGap: o.reappearGap,
    })),
    events: r.events,
    truncated: r.truncated,
    warnings: r.warnings,
    warningCounts: r.warningCounts,
    stats: r.stats,
  };
}
