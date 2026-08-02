import { createHash } from "node:crypto";
import { z } from "zod";

export const physicalBlindDigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/);
export const physicalBlindSafeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/);
export const physicalBlindRunIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
export const physicalBlindPurposeSchema = z.enum(["development", "holdout"]);
export type PhysicalBlindPurpose = z.infer<typeof physicalBlindPurposeSchema>;

export class PhysicalBlindArtifactError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "PhysicalBlindArtifactError";
    this.code = code;
  }
}

export function failPhysicalBlind(code: string): never {
  throw new PhysicalBlindArtifactError(code);
}

export function parsePhysicalBlindJson(text: string): unknown {
  if (typeof text !== "string") {
    failPhysicalBlind("BLIND_ARTIFACT_JSON_INVALID");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    failPhysicalBlind("BLIND_ARTIFACT_JSON_INVALID");
  }
}

export function parseVersionedStrictArtifact<T>(input: {
  readonly value: unknown;
  readonly schema: z.ZodType<T>;
  readonly supportedVersions?: readonly number[];
}): T {
  const value = input.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failPhysicalBlind("BLIND_ARTIFACT_DOCUMENT_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "schemaVersion")) {
    failPhysicalBlind("BLIND_ARTIFACT_FIELD_MISSING");
  }
  const supportedVersions = input.supportedVersions ?? [1];
  if (
    typeof record.schemaVersion !== "number" ||
    !supportedVersions.includes(record.schemaVersion)
  ) {
    failPhysicalBlind("BLIND_ARTIFACT_VERSION_UNSUPPORTED");
  }
  const parsed = input.schema.safeParse(value);
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")) {
      failPhysicalBlind("BLIND_ARTIFACT_EXTRA_FIELD");
    }
    if (
      parsed.error.issues.some((issue) =>
        issue.code === "invalid_type" &&
        !hasOwnPath(record, issue.path)
      )
    ) {
      failPhysicalBlind("BLIND_ARTIFACT_FIELD_MISSING");
    }
    failPhysicalBlind("BLIND_ARTIFACT_DOCUMENT_INVALID");
  }
  return parsed.data;
}

export function hashPhysicalBlindValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

export function serializePhysicalBlindArtifact(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function deepFreezePhysicalBlind<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezePhysicalBlind(child);
  }
  return Object.freeze(value);
}

export function assertUniquePhysicalBlindSampleIds(
  samples: readonly { readonly safeId: string }[]
): void {
  if (new Set(samples.map((sample) => sample.safeId)).size !== samples.length) {
    failPhysicalBlind("BLIND_ARTIFACT_DUPLICATE_SAMPLE");
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

function hasOwnPath(
  root: Record<string, unknown>,
  path: readonly PropertyKey[]
): boolean {
  let current: unknown = root;
  for (const component of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.hasOwn(current, component)
    ) {
      return false;
    }
    current = (current as Record<PropertyKey, unknown>)[component];
  }
  return true;
}
