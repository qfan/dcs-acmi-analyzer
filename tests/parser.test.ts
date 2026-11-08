import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectContainer } from "../src/acmi/container.ts";
import { LineSplitter } from "../src/acmi/lines.ts";
import type { AcmiObject, Recording } from "../src/acmi/model.ts";
import { AcmiParser, normaliseId, parseAcmi } from "../src/acmi/parser.ts";
import { T_ALT, T_HEADING, T_LAT, T_LON, T_PITCH, T_ROLL, T_U, T_V, T_YAW } from "../src/acmi/tracks.ts";
import { bytesChunks, fileChunks, fixture, sample } from "./helpers.ts";

const HEADER = "﻿FileType=text/acmi/tacview\nFileVersion=2.2\n";

function parseText(body: string, withHeader = true): Recording {
  const p = new AcmiParser();
  const s = new LineSplitter((l) => p.line(l));
  s.push(new TextEncoder().encode((withHeader ? HEADER : "") + body));
  return p.finish(s.end().incompleteTail);
}

const obj = (r: Recording, id: string, life = 0) => {
  const o = r.objects.find((x) => x.id === id && x.life === life);
  if (!o) throw new Error(`object ${id} not found`);
  return o;
};

/** Full transform state of sample i as [lon, lat, alt, roll, pitch, yaw, u, v, heading]. */
function sampleAt(o: AcmiObject, i: number): number[] {
  const t = o.transform;
  if (!t) throw new Error("no transform");
  const rest = Array.from(t.rest.subarray(i * 7, i * 7 + 7));
  return [t.lon[i] as number, t.lat[i] as number, ...rest];
}

describe("normaliseId", () => {
  it("lowercases, strips leading zeros, rejects non-hex and >64-bit", () => {
    expect(normaliseId("3000A01")).toBe("3000a01");
    expect(normaliseId("000101")).toBe("101");
    expect(normaliseId("0")).toBe("0");
    expect(normaliseId("xyz")).toBeNull();
    expect(normaliseId("")).toBeNull();
    expect(normaliseId("12345678901234567")).toBeNull();
    expect(normaliseId("ffffffffffffffff")).toBe("ffffffffffffffff");
  });
});

describe("T= transform", () => {
  it("maps the four forms to the right slots", () => {
    const r = parseText("#0\na,T=1|2|3\nb,T=1|2|3|40|50\nc,T=1|2|3|4|5|6\nd,T=1|2|3|4|5|6|70|80|9\n");
    const nan = Number.NaN;
    expect(sampleAt(obj(r, "a"), 0)).toEqual([1, 2, 3, nan, nan, nan, nan, nan, nan]);
    expect(sampleAt(obj(r, "b"), 0)).toEqual([1, 2, 3, nan, nan, nan, 40, 50, nan]);
    expect(sampleAt(obj(r, "c"), 0)).toEqual([1, 2, 3, 4, 5, 6, nan, nan, nan]);
    expect(sampleAt(obj(r, "d"), 0)).toEqual([1, 2, 3, 4, 5, 6, 70, 80, 9]);
  });

  it("keeps values for empty components (spec: unchanged)", () => {
    const r = parseText("#0\n1,T=1|2|3|4|5|6\n#1\n1,T=||30|||60\n#2\n1,T=1.5||\n");
    const o = obj(r, "1");
    expect(sampleAt(o, 1)).toEqual([1, 2, 30, 4, 5, 60, Number.NaN, Number.NaN, Number.NaN]);
    expect(sampleAt(o, 2).slice(0, 3)).toEqual([1.5, 2, 30]);
    expect(Array.from(o.transform?.times ?? [])).toEqual([0, 1, 2]);
  });

  it("handles DCS mixing 9- and 5-component updates on one object, keeping rotation", () => {
    // Real lines from the 2019 sample (object 101).
    const r = parseText(
      "#0.55\n101,T=5.3011048|5.2203143|1997.56||6.3||503210.5|-297997.44|\n" +
        "#0.66\n101,T=5.301272|5.2203083|1997.62|503224.38|-297996.91\n",
    );
    const o = obj(r, "101");
    const s = sampleAt(o, 1);
    expect(s[T_LON]).toBe(5.301272);
    expect(s[T_ALT]).toBeCloseTo(1997.62, 2);
    expect(s[T_PITCH]).toBeCloseTo(6.3, 5); // kept from the 9-component line
    expect(s[T_U]).toBeCloseTo(503224.38, 1);
    expect(s[T_V]).toBeCloseTo(-297996.91, 1);
    expect(o.tForms).toEqual([5, 9]);
    expect(r.stats.objectsMixingTForms).toBe(1);
  });

  it("warns on an unexpected component count", () => {
    const r = parseText("#0\n1,T=1|2\n");
    expect(r.warningCounts["t-components"]).toBe(1);
    expect(obj(r, "1").transform).toBeNull();
  });

  it("keeps the last sample when an object is updated twice in one frame", () => {
    const r = parseText("#0\n1,T=1|2|3\n1,T=1|2|4\n");
    const o = obj(r, "1");
    expect(o.transform?.times.length).toBe(1);
    expect(sampleAt(o, 0)[T_ALT]).toBe(4);
  });
});

describe("objects and properties", () => {
  it("records text and numeric properties with escaped commas", () => {
    const r = parseText("#0\n1,Name=F-16C,Pilot=Smith\\, John,Type=Air+FixedWing,IAS=111.5\n#2\n1,IAS=120\n");
    const o = obj(r, "1");
    expect(o.pilot).toBe("Smith, John");
    expect(o.tags).toEqual(["Air", "FixedWing"]);
    expect(Array.from(o.numbers.IAS?.values ?? [])).toEqual([111.5, 120]);
  });

  it("stores unknown properties: numeric if they parse, text otherwise", () => {
    const r = parseText("#0\n1,PlaybackKey=abc,Foo=12.5\n");
    const o = obj(r, "1");
    expect(o.text.PlaybackKey?.values).toEqual(["abc"]);
    expect(Array.from(o.numbers.Foo?.values ?? [])).toEqual([12.5]);
    expect(r.stats.unknownProps).toEqual({ PlaybackKey: 1, Foo: 1 });
  });

  it("places lines before the first frame at time 0", () => {
    const r = parseText("40000001,T=1|2|3,Type=Navaid+Static+Bullseye\n#5\n");
    expect(obj(r, "40000001").createdAt).toBe(0);
  });

  it("removes objects and treats a reused ID as a new object", () => {
    const r = parseText("#1\n1,Name=A\n#2\n-1\n#3\n1,Name=B\n#4\n-2\n");
    expect(obj(r, "1", 0)).toMatchObject({ name: "A", createdAt: 1, removedAt: 2 });
    expect(obj(r, "1", 1)).toMatchObject({ name: "B", createdAt: 3, removedAt: null });
    expect(r.stats.idReuses).toBe(1);
    expect(r.warningCounts["remove-unknown"]).toBe(1);
  });

  it("links a reused ID to its previous object (DCS remove-and-re-add glitch)", () => {
    // Shape from a real 2019 PvP recording: Su-33 removed at 102.48, back 0.02 s later.
    const r = parseText(
      "#102.38\n3e103,T=5.8|6.5|7044|||170|359074|65959|166,Type=Air+FixedWing,Name=Su-33,Pilot=007\n" +
        "#102.48\n-3e103\n#102.5\n3e103,T=5.8|6.5|7044.6|||170|359074|65963|166,Type=Air+FixedWing,Name=Su-33,Pilot=007\n",
    );
    const second = obj(r, "3e103", 1);
    expect(second.previousUid).toBe(obj(r, "3e103", 0).uid);
    expect(second.reappearGap).toBeCloseTo(0.02, 6);
    expect(r.stats.idReuseGaps).toEqual({ "<0.1s": 1 });
    expect(r.stats.idReusesSameIdentity).toBe(1);
  });

  it("sorts samples when frames go backwards (the spec allows out-of-order data)", () => {
    const r = parseText("#2\n1,T=2|0|0\n#1\n1,T=1|0|0\n#3\n1,T=3|0|0\n");
    const o = obj(r, "1");
    expect(Array.from(o.transform?.times ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(o.transform?.lon ?? [])).toEqual([1, 2, 3]);
    expect(r.stats.framesBackwards).toBe(1);
  });
});

describe("globals and events", () => {
  it("parses reference point, globals and multi-line comments", () => {
    const r = parseText(
      "0,ReferenceTime=2018-08-01T03:00:00Z\n0,ReferenceLongitude=39\n0,ReferenceLatitude=37\n" +
        "0,Comments=a\\, b.\\\n\\\nc\n#0\n0,Category=CAP\n0,AuthenticationKey=x|y\n",
    );
    expect(r.refLon).toBe(39);
    expect(r.refLat).toBe(37);
    expect(r.referenceTime).toBe("2018-08-01T03:00:00Z");
    expect(r.globals.Comments).toBe("a, b.\n\nc");
    expect(r.globals.Category).toBe("CAP");
    expect(r.globals.AuthenticationKey).toBe("(1 keys)");
  });

  it("parses the spec's event forms", () => {
    const r = parseText(
      "#1\n6a56,Name=X\n#2\n0,Event=Destroyed|6A56|\n0,Event=Bookmark|Hello\n" +
        "0,Event=Message|705|3e|Two objects\n" +
        "0,Event=Timeout|SourceId:507|AmmoType:FOX2|TargetId:6a56|Outcome:Kill|\n",
    );
    expect(r.events.map((e) => e.type)).toEqual(["Destroyed", "Bookmark", "Message", "Timeout"]);
    expect(r.events[0]).toMatchObject({ time: 2, objectIds: ["6a56"], text: "" });
    expect(r.events[1]).toMatchObject({ objectIds: [], text: "Hello" });
    expect(r.events[2]).toMatchObject({ objectIds: ["705", "3e"], text: "Two objects" });
    expect(r.events[3]?.params).toEqual({
      SourceId: "507",
      AmmoType: "FOX2",
      TargetId: "6a56",
      Outcome: "Kill",
    });
    expect(obj(r, "6a56").destroyedAt).toBe(2);
  });

  it("flags a missing or unexpected header", () => {
    const r = parseText("#0\n", false);
    expect(r.warningCounts.header).toBe(2);
  });
});

describe("container detection", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it("recognises zip, 7z, gzip, plain (with and without BOM), empty and junk", () => {
    expect(detectContainer(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe("zip");
    expect(detectContainer(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]))).toBe("7z");
    expect(detectContainer(new Uint8Array([0x1f, 0x8b, 8, 0]))).toBe("gzip");
    expect(detectContainer(enc("﻿FileType=text/acmi/tacview"))).toBe("plain");
    expect(detectContainer(enc("FileType=text/acmi/tacview"))).toBe("plain");
    expect(detectContainer(new Uint8Array(0))).toBe("empty");
    expect(detectContainer(enc("hello world, not acmi"))).toBe("unknown");
  });
});

describe("built-in sample: 2v1 ACM (expected values counted independently in PowerShell)", () => {
  it("parses the whole recording", async () => {
    const r = await parseAcmi(fileChunks(sample("dcs-2021-f16-2v1-acm.zip.acmi")));
    expect(r.container).toEqual({
      kind: "zip",
      entryName: "Tacview-20210912-013539-DCS-F-16C - Caucasus - 2v1 ACM.txt.acmi",
    });
    expect(r.fileVersion).toBe("2.2");
    expect(r.globals.Title).toBe("F-16C - Caucasus - 2v1 ACM");
    expect(r.globals.Comments).toContain("in front of you, behind you, or to the side.");
    expect(r.globals.Comments).toContain("\n\nGive the radio command");
    expect(r.stats.frames).toBe(6329);
    expect(r.timeEnd).toBe(155.04);
    expect(r.objects).toHaveLength(280);
    expect(r.stats.removals).toBe(268);
    expect(r.stats.textBytes).toBe(1007935);
    expect(r.objects.filter((o) => o.type === "Air+FixedWing")).toHaveLength(9);
    expect(r.objects.filter((o) => o.type === "Weapon+Missile").map((o) => o.name)).toEqual([
      "AIM_9X",
      "P_73",
      "P_73",
    ]);
    expect(r.truncated).toBe(false);
    expect(r.warnings).toEqual([]);

    // Known story beats (see PLAN.md §3).
    expect(obj(r, "101")).toMatchObject({ name: "MiG-29A", createdAt: 13.1, removedAt: 65.68 });
    expect(obj(r, "1e01")).toMatchObject({ name: "AIM_9X", createdAt: 62.55, removedAt: 65.68 });
    expect(obj(r, "1401")).toMatchObject({ name: "F-16C_50", pilot: "QFAN", group: "Player", color: "Blue" });

    // First two samples of the player's F-16: empty roll/pitch stay unset, then yaw carries over.
    const f16 = obj(r, "1401");
    const s0 = sampleAt(f16, 0);
    expect(s0[T_LON]).toBe(5.0329697);
    expect(s0[T_LAT]).toBe(6.0176506);
    expect(s0[T_ROLL]).toBeNaN();
    expect(s0[T_YAW]).toBeCloseTo(280.4, 4);
    expect(s0[T_HEADING]).toBeCloseTo(272.7, 4);
    const s1 = sampleAt(f16, 1);
    expect(s1[T_ROLL]).toBeCloseTo(-0.1, 5);
    expect(s1[T_YAW]).toBeCloseTo(280.4, 4); // empty in the file → unchanged
    expect(s1[T_V]).toBeCloseTo(-175880.11, 1);
    expect(f16.transform?.times[1]).toBe(0.12);
    expect(r.refLon + (s0[T_LON] ?? Number.NaN)).toBeCloseTo(44.0329697, 7);
  });

  it("gives identical results regardless of chunk size", async () => {
    const bytes = new Uint8Array(readFileSync(sample("dcs-2021-f16-2v1-acm.zip.acmi")));
    const a = await parseAcmi(bytesChunks(bytes, 7));
    const b = await parseAcmi(bytesChunks(bytes, 1 << 20));
    a.stats.rawBytes = 0;
    b.stats.rawBytes = 0;
    expect(a).toEqual(b);
  });
});

describe("edge-case fixtures", () => {
  it("reads the oldest recorder (DCS2ACMI 1.8.1, 2019): A-10 removed, pilot appears", async () => {
    const r = await parseAcmi(fileChunks(fixture("dcs-2019-tiny.zip.acmi")));
    expect(r.globals.DataRecorder).toBe("DCS2ACMI 1.8.1");
    expect(r.timeEnd).toBe(7.73);
    expect(obj(r, "101")).toMatchObject({ name: "A-10A", removedAt: 6.2 });
    expect(obj(r, "201")).toMatchObject({ type: "Ground+Light+Human+Air+Parachutist", createdAt: 6.2 });
    expect(r.warnings).toEqual([]);
  });

  it("flags an unfinished plain-text recording and ignores its cut-off last line", async () => {
    const r = await parseAcmi(fileChunks(fixture("dcs-2021-truncated.txt.acmi")));
    expect(r.container.kind).toBe("plain");
    expect(r.truncated).toBe(true);
    expect(r.timeEnd).toBe(42.16);
    expect(r.warnings.map((w) => w.kind)).toEqual(["truncated"]);
  });

  it("recovers an unfinished zip (header says size 0, no central directory)", async () => {
    const r = await parseAcmi(fileChunks(fixture("dcs-2025-unfinished-zip.zip.acmi")));
    expect(r.container).toEqual({
      kind: "zip",
      entryName: "Tacview-20251019-105215-DCS.txt.acmi",
      incomplete: true,
    });
    expect(r.fileVersion).toBe("2.2");
    expect(r.globals.DataRecorder).toBe("DCS2ACMI 1.9.4.200");
    expect(r.truncated).toBe(true);
    expect(Object.keys(r.warningCounts).sort()).toEqual(["incomplete-zip", "truncated"]);
    expect(r.objects.length).toBeGreaterThan(0);
  });

  it("rejects an empty file with a clear message", async () => {
    await expect(parseAcmi(bytesChunks(new Uint8Array(0), 10))).rejects.toThrow("empty");
  });
});
