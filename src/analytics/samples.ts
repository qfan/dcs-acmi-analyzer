/** Built-in multi-file sample pack for the ACMI Missile & Engagement Analytics tool. */
export interface AnalyticsSample {
  id: string;
  file: string;
  originalName: string;
  description: string;
}

export const ANALYTICS_SAMPLES: AnalyticsSample[] = [
  {
    id: "bvr-mission1",
    file: "samples/dcs-2025-bvr-mission1-prep.zip.acmi",
    originalName: "Tacview-20250115-194603-DCS-2025-01_mission1_prep.zip.acmi",
    description: "BVR multi-ship engagement: R-27ER, R-77, R-27ET across High→Low, Low→High & Co-Alt High",
  },
  {
    id: "f18-vs-jf17-bvr",
    file: "samples/dcs-2025-f18-vs-jf17-bvr-hi.zip.acmi",
    originalName: "Tacview-20250308-161019-DCS-18(aim120)vsJF17(sd10) - hi - far.zip.acmi",
    description: "Long-range High-Altitude Fox-3 BVR duel: F/A-18C (AIM-120C) vs JF-17 (SD-10) at 65–82 km",
  },
  {
    id: "mig29-high-vs-f18",
    file: "samples/dcs-2025-mig29-high-vs-f18.zip.acmi",
    originalName: "Tacview-20250116-004513-DCS-mig29_high_vs_f18.zip.acmi",
    description: "Dissimilar altitude BVR: High→Low AIM-120C (33 km) & Low→High R-27ET (23 km)",
  },
  {
    id: "f18-aim9x-low",
    file: "samples/dcs-2025-f18-aim9x-low.zip.acmi",
    originalName: "Tacview-20250302-212829-DCS-Persian Gulf FA-18C AIM-9X Sidewinder.zip.acmi",
    description: "Co-Altitude Low WVR: F/A-18C AIM-9X tail-chase & rear-quarter kills",
  },
  {
    id: "f16-2v1-acm",
    file: "samples/dcs-2021-f16-2v1-acm.zip.acmi",
    originalName: "Tacview-20210912-013539-DCS-F-16C - Caucasus - 2v1 ACM.zip.acmi",
    description: "2v1 ACM merge: F-16C vs MiG-29A & Su-27 (AIM-9X beam Co-Alt High, R-73 Low→High, Gun)",
  },
  {
    id: "wvr-fox2",
    file: "samples/dcs-2026-wvr-fox2.zip.acmi",
    originalName: "Tacview-20260818-124753-DCS.zip.acmi",
    description: "WVR Fox-2 dogfight: AIM-9X beam Co-Alt High & R-73 tail-on High→Low",
  },
];

export function shouldAutoLoadSamples(search: string): boolean {
  const p = new URLSearchParams(search).get("sample");
  if (p === "none") return false;
  if (p === "default" || p === "all") return true;
  return Boolean(import.meta.env.DEV);
}

export async function fetchAnalyticsSample(s: AnalyticsSample): Promise<Blob> {
  const res = await fetch(`${import.meta.env.BASE_URL}${s.file}`);
  if (!res.ok) throw new Error(`Could not load sample ${s.id} (${res.status})`);
  return res.blob();
}
