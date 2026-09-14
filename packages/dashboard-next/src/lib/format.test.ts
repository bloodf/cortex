import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { bytes, kbps, duration, relativeTime, ms, percent } from "./format";

describe("bytes", () => {
  it("returns 0 B for non-positive / non-finite", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(-10)).toBe("0 B");
    expect(bytes(NaN)).toBe("0 B");
    expect(bytes(Infinity)).toBe("0 B");
  });
  it("formats small byte counts without decimals", () => {
    expect(bytes(512)).toBe("512 B");
  });
  it("formats kilobytes with 1 decimal", () => {
    expect(bytes(1536)).toBe("1.5 KB");
  });
  it("formats megabytes and gigabytes", () => {
    expect(bytes(1024 * 1024)).toBe("1.0 MB");
    expect(bytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });
  it("caps at PB for huge numbers", () => {
    expect(bytes(1024 ** 6)).toMatch(/PB$/);
  });
});

describe("kbps", () => {
  it("returns 0 Kbps for non-positive", () => {
    expect(kbps(0)).toBe("0 Kbps");
    expect(kbps(-1)).toBe("0 Kbps");
  });
  it("returns kbps under 1024", () => {
    expect(kbps(500)).toBe("500 Kbps");
  });
  it("returns Mbps between 1024 and 1024^2", () => {
    expect(kbps(2048)).toBe("2.00 Mbps");
  });
  it("returns Gbps for very large", () => {
    expect(kbps(1024 * 1024 * 3)).toBe("3.00 Gbps");
  });
});

describe("duration", () => {
  it("formats seconds", () => {
    expect(duration(30)).toBe("30s");
  });
  it("formats minutes", () => {
    expect(duration(120)).toBe("2m");
  });
  it("formats hours and minutes", () => {
    expect(duration(3 * 3600 + 25 * 60)).toBe("3h 25m");
  });
  it("formats days, hours and minutes", () => {
    expect(duration(2 * 86400 + 4 * 3600 + 15 * 60)).toBe("2d 4h 15m");
  });
});

describe("relativeTime", () => {
  beforeAll(() => vi.useFakeTimers().setSystemTime(new Date("2026-01-01T12:00:00Z")));
  afterAll(() => vi.useRealTimers());

  it("returns 'just now' under 5s", () => {
    expect(relativeTime(new Date("2026-01-01T11:59:58Z"))).toBe("just now");
  });
  it("returns seconds ago", () => {
    expect(relativeTime(new Date("2026-01-01T11:59:30Z"))).toBe("30s ago");
  });
  it("returns minutes ago", () => {
    expect(relativeTime(new Date("2026-01-01T11:55:00Z"))).toBe("5m ago");
  });
  it("returns hours ago", () => {
    expect(relativeTime(new Date("2026-01-01T09:00:00Z"))).toBe("3h ago");
  });
  it("returns days ago", () => {
    expect(relativeTime(new Date("2025-12-30T12:00:00Z"))).toBe("2d ago");
  });
});

describe("ms", () => {
  it("rounds to nearest", () => {
    expect(ms(12.4)).toBe("12 ms");
    expect(ms(12.6)).toBe("13 ms");
  });
  it("returns em-dash for invalid", () => {
    expect(ms(NaN)).toBe("—");
    expect(ms(-1)).toBe("—");
  });
});

describe("percent", () => {
  it("defaults to 0 digits", () => {
    expect(percent(54.7)).toBe("55%");
  });
  it("respects digits", () => {
    expect(percent(54.736, 2)).toBe("54.74%");
  });
  it("returns em-dash for invalid", () => {
    expect(percent(NaN)).toBe("—");
  });
});
