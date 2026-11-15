/**
 * Monthly egress budget: counts bytes the relay sends and says when the month's allowance is spent.
 * Persisted to a small JSON file so a restart doesn't reset it. This is the relay's own spending cap
 * for VMs whose providers bill bandwidth overage without a hard limit.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

export class EgressBudget {
  private readonly file: string | null;
  private readonly limitBytes: number;
  private month = monthKey();
  private bytes = 0;

  /** `stateDir` null keeps the count in memory only (tests). `limitGb` 0 disables the cap. */
  constructor(stateDir: string | null, limitGb: number) {
    this.limitBytes = limitGb > 0 ? limitGb * 1e9 : Number.POSITIVE_INFINITY;
    this.file = stateDir ? join(stateDir, "egress.json") : null;
    if (!this.file || !stateDir) return;
    mkdirSync(stateDir, { recursive: true });
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (saved.month === this.month && Number.isFinite(saved.bytes)) this.bytes = saved.bytes;
    } catch {
      // No file yet, or unreadable: start the month at zero.
    }
  }

  add(n: number): void {
    this.rollover();
    this.bytes += n;
  }

  get exceeded(): boolean {
    this.rollover();
    return this.bytes >= this.limitBytes;
  }

  get used(): number {
    return this.bytes;
  }

  save(): void {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ month: this.month, bytes: this.bytes }));
    renameSync(tmp, this.file);
  }

  private rollover(): void {
    const m = monthKey();
    if (m !== this.month) {
      this.month = m;
      this.bytes = 0;
    }
  }
}
