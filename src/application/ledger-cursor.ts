import { InvalidCommandError } from "../domain/errors";

export function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ s: seq }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { s?: unknown };
    if (typeof parsed.s === "string" && /^[0-9]{1,19}$/.test(parsed.s)) {
      return parsed.s;
    }
  } catch {
    throw new InvalidCommandError("invalid fields: cursor");
  }
  throw new InvalidCommandError("invalid fields: cursor");
}
