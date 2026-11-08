import { describe, expect, test } from "bun:test";
import { InvalidCommandError } from "../domain/errors";
import { decodeCursor, encodeCursor } from "./ledger-cursor";

describe("ledger cursor", () => {
  test("round trips the sequence", () => {
    expect(decodeCursor(encodeCursor("12345"))).toBe("12345");
  });

  test("is opaque and url safe", () => {
    expect(encodeCursor("42")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeCursor("42")).not.toContain("42");
  });

  test("rejects anything that is not a cursor we issued", () => {
    for (const bad of ["", "not-a-cursor", "e30", Buffer.from('{"s":"abc"}').toString("base64url"), Buffer.from('{"s":5}').toString("base64url")]) {
      expect(() => decodeCursor(bad)).toThrow(InvalidCommandError);
    }
  });
});
