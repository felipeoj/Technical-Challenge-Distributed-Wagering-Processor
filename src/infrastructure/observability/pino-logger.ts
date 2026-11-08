import pino from "pino";
import type { LogFields, Logger } from "../../application/ports";

export class PinoLogger implements Logger {
  private readonly pino: pino.Logger;

  constructor(level: string) {
    this.pino = pino({ level });
  }

  info(event: string, fields: LogFields = {}): void {
    this.pino.info({ event, ...fields });
  }

  warn(event: string, fields: LogFields = {}): void {
    this.pino.warn({ event, ...fields });
  }

  error(event: string, fields: LogFields = {}): void {
    this.pino.error({ event, ...fields });
  }
}
