import { EntitySchema } from "@mikro-orm/postgresql";

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: "outbox_message",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "string", fieldName: "aggregate_id" },
    eventType: { type: "string", fieldName: "event_type" },
    payload: { type: "json" },
    occurredAt: { type: "Date", fieldName: "occurred_at" },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "Date", fieldName: "next_attempt_at", nullable: true },
    publishedAt: { type: "Date", fieldName: "published_at", nullable: true },
  },
});
