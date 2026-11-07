import { describe, expect, test } from "bun:test";
import { backoffDelayMs } from "./backoff";

describe("backoffDelayMs", () => {
  test("doubles with each attempt", () => {
    expect(backoffDelayMs(1)).toBe(1000);
    expect(backoffDelayMs(2)).toBe(2000);
    expect(backoffDelayMs(3)).toBe(4000);
  });

  test("never exceeds the cap", () => {
    expect(backoffDelayMs(20)).toBe(300_000);
    expect(backoffDelayMs(5000)).toBe(300_000);
  });

  test("accepts custom base and cap", () => {
    expect(backoffDelayMs(3, 500, 1500)).toBe(1500);
  });
});
