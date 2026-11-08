import { z } from "zod";
import { InvalidCommandError } from "../../domain/errors";

const uuid = z.uuid();

export function assertUuid(value: string, field: string): string {
  if (!uuid.safeParse(value).success) {
    throw new InvalidCommandError(`invalid fields: ${field}`);
  }
  return value;
}
