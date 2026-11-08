/**
 * Compact, growable time-series storage for parsed telemetry.
 * Samples are appended in file order; finish() trims buffers and sorts if the file had
 * out-of-order times (the spec allows it).
 */

class GrowF64 {
  data = new Float64Array(8);
  length = 0;
  push(v: number): void {
    if (this.length === this.data.length) this.grow();
    this.data[this.length++] = v;
  }
  private grow(): void {
    const next = new Float64Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }
  trim(): Float64Array {
    this.data = this.data.slice(0, this.length);
    return this.data;
  }
}

class GrowF32 {
  data: Float32Array;
  length = 0;
  constructor(initial = 8) {
    this.data = new Float32Array(initial);
  }
  ensure(n: number): void {
    if (n <= this.data.length) return;
    let cap = this.data.length * 2;
    while (cap < n) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.data);
    this.data = next;
  }
  push(v: number): void {
    this.ensure(this.length + 1);
    this.data[this.length++] = v;
  }
  trim(): Float32Array {
    this.data = this.data.slice(0, this.length);
    return this.data;
  }
}

/** Component slots of the T= transform. Longitude/latitude are relative to the reference point. */
export const T_LON = 0;
export const T_LAT = 1;
export const T_ALT = 2;
export const T_ROLL = 3;
export const T_PITCH = 4;
export const T_YAW = 5;
export const T_U = 6;
export const T_V = 7;
export const T_HEADING = 8;
export const T_SLOTS = 9;
/** Slots after lon/lat, stored as float32 (altitude, angles, flat-world metres). */
const REST = 7;

/**
 * Full transform state per sample. Components that were never set are NaN.
 * lon/lat are float64 (relative degrees); the other 7 slots are float32.
 */
export class TransformTrack {
  private readonly t = new GrowF64();
  private readonly lon = new GrowF64();
  private readonly lat = new GrowF64();
  private readonly rest = new GrowF32(8 * REST);
  private sorted = true;

  get length(): number {
    return this.t.length;
  }

  /** Append a full-state sample. A second sample at the same time replaces the first. */
  push(time: number, s: Float64Array): void {
    const n = this.t.length;
    if (n > 0) {
      const last = this.t.data[n - 1] as number;
      if (time === last) {
        this.write(n - 1, s);
        return;
      }
      if (time < last) this.sorted = false;
    }
    this.t.push(time);
    this.lon.push(s[T_LON] as number);
    this.lat.push(s[T_LAT] as number);
    this.rest.ensure((n + 1) * REST);
    this.rest.length = (n + 1) * REST;
    this.write(n, s);
  }

  private write(i: number, s: Float64Array): void {
    this.lon.data[i] = s[T_LON] as number;
    this.lat.data[i] = s[T_LAT] as number;
    const r = this.rest.data;
    const o = i * REST;
    for (let k = 0; k < REST; k++) r[o + k] = s[k + 2] as number;
  }

  finish(): TransformData {
    let times = this.t.trim();
    let lon = this.lon.trim();
    let lat = this.lat.trim();
    let rest = this.rest.trim();
    if (!this.sorted) {
      const order = sortOrder(times);
      times = permute64(times, order);
      lon = permute64(lon, order);
      lat = permute64(lat, order);
      const r2 = new Float32Array(rest.length);
      order.forEach((src, dst) => {
        r2.set(rest.subarray(src * REST, src * REST + REST), dst * REST);
      });
      rest = r2;
    }
    return { times, lon, lat, rest };
  }
}

export interface TransformData {
  times: Float64Array;
  /** Relative longitude (add Recording.refLon). */
  lon: Float64Array;
  /** Relative latitude (add Recording.refLat). */
  lat: Float64Array;
  /** 7 values per sample: alt, roll, pitch, yaw, u, v, heading. */
  rest: Float32Array;
}

export class NumberTrack {
  private readonly t = new GrowF64();
  private readonly v = new GrowF32();
  private sorted = true;
  push(time: number, value: number): void {
    const n = this.t.length;
    if (n > 0) {
      const last = this.t.data[n - 1] as number;
      if (time === last) {
        this.v.data[n - 1] = value;
        return;
      }
      if (time < last) this.sorted = false;
    }
    this.t.push(time);
    this.v.push(value);
  }
  finish(): NumberData {
    let times = this.t.trim();
    let values = this.v.trim();
    if (!this.sorted) {
      const order = sortOrder(times);
      times = permute64(times, order);
      const v2 = new Float32Array(values.length);
      order.forEach((src, dst) => {
        v2[dst] = values[src] as number;
      });
      values = v2;
    }
    return { times, values };
  }
}

export interface NumberData {
  times: Float64Array;
  values: Float32Array;
}

/** Text values, stored only when they change. */
export interface TextData {
  times: number[];
  values: string[];
}

export class TextTrack {
  readonly data: TextData = { times: [], values: [] };
  push(time: number, value: string): void {
    const d = this.data;
    const n = d.times.length;
    if (n > 0 && d.values[n - 1] === value) return;
    if (n > 0 && d.times[n - 1] === time) {
      d.values[n - 1] = value;
      return;
    }
    d.times.push(time);
    d.values.push(value);
  }
  finish(): TextData {
    const d = this.data;
    for (let i = 1; i < d.times.length; i++) {
      if ((d.times[i] as number) < (d.times[i - 1] as number)) {
        const order = sortOrder(Float64Array.from(d.times));
        return {
          times: order.map((i2) => d.times[i2] as number),
          values: order.map((i2) => d.values[i2] as string),
        };
      }
    }
    return d;
  }
}

function sortOrder(times: Float64Array): number[] {
  const idx = Array.from({ length: times.length }, (_, i) => i);
  idx.sort((a, b) => (times[a] as number) - (times[b] as number) || a - b);
  return idx;
}

function permute64(a: Float64Array, order: number[]): Float64Array {
  const out = new Float64Array(a.length);
  order.forEach((src, dst) => {
    out[dst] = a[src] as number;
  });
  return out;
}

/** Index of the last sample with time <= t, or -1. */
export function indexAt(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
