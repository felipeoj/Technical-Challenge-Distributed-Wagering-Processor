import { z } from "zod";
import { InvalidCommandError } from "../../domain/errors";
import { safeText } from "./safe-text";

const openWalletSchema = z.object({
  playerId: safeText(100),
  initialBalance: z.object({ amount: z.string(), currency: z.string() }),
});

export type OpenWalletCommand = z.infer<typeof openWalletSchema>;

export function parseOpenWalletCommand(raw: unknown): OpenWalletCommand {
  const parsed = openWalletSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "body"))];
    throw new InvalidCommandError(`invalid fields: ${fields.join(", ")}`);
  }
  return parsed.data;
}
