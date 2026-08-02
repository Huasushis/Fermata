import { failPhysicalBlind } from "./physical-blind-common";

export function parsePhysicalBlindCliOptions(
  argv: readonly string[],
  names: readonly string[]
): Readonly<Record<string, string>> {
  const allowed = new Set(names);
  const result: Record<string, string> = {};
  for (const argument of argv) {
    const match = /^--([a-z][a-z-]*)=(.+)$/.exec(argument);
    if (match === null) {
      failPhysicalBlind("BLIND_CLI_ARGUMENT_INVALID");
    }
    const [, name, value] = match;
    if (
      name === undefined ||
      value === undefined ||
      !allowed.has(name) ||
      Object.hasOwn(result, name) ||
      value.includes("\0")
    ) {
      failPhysicalBlind("BLIND_CLI_ARGUMENT_INVALID");
    }
    result[name] = value;
  }
  if (names.some((name) => !Object.hasOwn(result, name))) {
    failPhysicalBlind("BLIND_CLI_ARGUMENT_MISSING");
  }
  return Object.freeze(result);
}

export function physicalBlindCliErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,160}$/.test(error.code)
  ) {
    return error.code;
  }
  return "BLIND_CLI_FAILED";
}
