import { z } from "zod";
import { InvalidCommandError } from "../../domain/errors";
import { safeText } from "./safe-text";
import { WagerTransactionKind } from "../../domain/wagering/wager-transaction-kind";

const wagerCommandSchema = z.object({
  providerId: safeText(100),
  externalTransactionId: safeText(200),
  playerId: safeText(100),
  walletId: z.uuid(),
  roundId: safeText(200),
  gameId: safeText(200),
  kind: z.enum([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ]),
  money: z.object({ amount: z.string(), currency: z.string() }),
  referenceExternalTransactionId: safeText(200).optional(),
});

export type WagerCommand = z.infer<typeof wagerCommandSchema>;

export function parseWagerCommand(raw: unknown): WagerCommand {
  const parsed = wagerCommandSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "body"))];
    throw new InvalidCommandError(`invalid fields: ${fields.join(", ")}`);
  }
  return parsed.data;
}
