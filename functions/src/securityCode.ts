import { randomInt } from "node:crypto";

type RandomInt = (min: number, max: number) => number;

export function generateSecurityCode(nextInt: RandomInt = randomInt): string {
  const value = nextInt(0, 1_000_000);
  if (!Number.isInteger(value) || value < 0 || value >= 1_000_000) {
    throw new RangeError("Security code random source returned an out-of-range value.");
  }
  const digits = value.toString().padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}
