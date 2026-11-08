import { z } from "zod";

export function safeText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\u0000"));
}

export function hasNullByte(value: string): boolean {
  return value.includes("\u0000");
}
