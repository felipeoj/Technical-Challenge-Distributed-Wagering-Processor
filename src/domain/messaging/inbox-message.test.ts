import { describe, expect, test } from "bun:test";
import { InvalidMessageStateError } from "../errors";
import { InboxMessage } from "./inbox-message";

const receivedAt = new Date("2026-11-07T12:00:00.000Z");
const processedAt = new Date("2026-11-07T12:00:01.000Z");

const receive = () =>
  InboxMessage.receive({ messageId: "m1", consumerName: "wager-consumer", payloadHash: "h1", receivedAt });

describe("InboxMessage", () => {
  test("is received unprocessed", () => {
    const message = receive();
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test("markProcessed records the time", () => {
    const message = receive();
    message.markProcessed(processedAt);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(processedAt);
  });

  test("cannot be processed twice", () => {
    const message = receive();
    message.markProcessed(processedAt);
    expect(() => message.markProcessed(processedAt)).toThrow(InvalidMessageStateError);
  });

  test("rehydrate restores a processed message", () => {
    const message = InboxMessage.rehydrate({
      messageId: "m1",
      consumerName: "wager-consumer",
      payloadHash: "h1",
      receivedAt,
      processedAt,
    });
    expect(message.isProcessed()).toBe(true);
  });
});
