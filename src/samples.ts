/** Built-in sample recordings served from /public/samples. */
export interface Sample {
  id: string;
  file: string;
  /** Original Tacview file name, shown in the UI. */
  originalName: string;
  description: string;
}

export const SAMPLES: Sample[] = [
  {
    id: "default",
    file: "samples/dcs-2021-f16-2v1-acm.zip.acmi",
    originalName: "Tacview-20210912-013539-DCS-F-16C - Caucasus - 2v1 ACM.zip.acmi",
    description: "DCS 2.7, F-16C 2v1 vs MiG-29A / Su-27: missile kills, guns, ejections",
  },
];

/**
 * Which sample to auto-load, from `?sample=<id>`. In dev mode the default sample loads
 * automatically unless `?sample=none` is given.
 */
export function sampleFromUrl(search: string): Sample | null {
  const p = new URLSearchParams(search).get("sample");
  if (p === "none") return null;
  const id = p ?? (import.meta.env.DEV ? "default" : null);
  return SAMPLES.find((s) => s.id === id) ?? null;
}

export async function fetchSample(s: Sample): Promise<Blob> {
  const res = await fetch(`${import.meta.env.BASE_URL}${s.file}`);
  if (!res.ok) throw new Error(`Could not load sample (${res.status})`);
  return res.blob();
}
