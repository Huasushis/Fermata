import { createHash } from "node:crypto";
import { z } from "zod";
import {
  digestSchema,
  evidenceIdSchema,
  roleCompletionReceiptSchema,
  reviewFlowRoleSchema,
  roleIdentitySchema,
  type RoleCompletionReceipt,
  type ReviewFlowRole,
  type RoleIdentity
} from "./schemas";

export interface EvidenceArtifact<TPayload> {
  readonly schemaVersion: 2;
  readonly evidenceId: string;
  readonly role: ReviewFlowRole;
  readonly problemContentHash: string;
  /** 当前角色实际收到的最小视图哈希，绑定标签目录、查重证据和上游 artifacts。 */
  readonly inputHash: string;
  readonly promptVersion: string;
  readonly modelIdentity: string;
  /** 编排器本地对完整输入快照计算的哈希；不能由模型自报。 */
  readonly sourceSnapshotHash: string;
  readonly execution: EvidenceExecutionBinding;
  readonly payloadHash: string;
  readonly payload: Readonly<TPayload>;
}

export type EvidenceExecutionBinding =
  | {
      readonly trust: "untrusted_local";
      readonly runContextHash: null;
      readonly completionReceipt: null;
    }
  | {
      readonly trust: "trusted_llm";
      readonly runContextHash: string;
      readonly completionReceipt: RoleCompletionReceipt;
    };

const evidenceExecutionBindingSchema = z.discriminatedUnion("trust", [
  z
    .object({
      trust: z.literal("untrusted_local"),
      runContextHash: z.null(),
      completionReceipt: z.null()
    })
    .strict(),
  z
    .object({
      trust: z.literal("trusted_llm"),
      runContextHash: digestSchema,
      completionReceipt: roleCompletionReceiptSchema
    })
    .strict()
]);

const artifactBaseSchema = z
  .object({
    schemaVersion: z.literal(2),
    evidenceId: evidenceIdSchema,
    role: reviewFlowRoleSchema,
    problemContentHash: digestSchema,
    inputHash: digestSchema,
    promptVersion: roleIdentitySchema.shape.promptVersion,
    modelIdentity: digestSchema,
    sourceSnapshotHash: digestSchema,
    execution: evidenceExecutionBindingSchema,
    payloadHash: digestSchema
  })
  .strict();

/** 模型原始响应只在内存中进入 strict payload；artifact 不负责写盘或日志。 */
export function sealEvidenceArtifact<TPayload>(input: {
  readonly role: ReviewFlowRole;
  readonly problemContentHash: string;
  readonly inputHash: string;
  readonly sourceSnapshotHash: string;
  readonly execution: EvidenceExecutionBinding;
  readonly identity: RoleIdentity;
  readonly payloadSchema: z.ZodType<TPayload>;
  readonly payload: unknown;
}): EvidenceArtifact<TPayload> {
  const role = reviewFlowRoleSchema.parse(input.role);
  const problemContentHash = digestSchema.parse(input.problemContentHash);
  const inputHash = digestSchema.parse(input.inputHash);
  const identity = roleIdentitySchema.parse(input.identity);
  const sourceSnapshotHash = digestSchema.parse(input.sourceSnapshotHash);
  const execution = evidenceExecutionBindingSchema.parse(structuredClone(input.execution));
  const payload = input.payloadSchema.parse(structuredClone(input.payload));
  const payloadHash = hashCanonicalValue(payload);
  const evidenceId = `ev-${hashCanonicalValue({
    schemaVersion: 2,
    role,
    problemContentHash,
    inputHash,
    promptVersion: identity.promptVersion,
    modelIdentity: identity.modelIdentity,
    sourceSnapshotHash,
    execution,
    payloadHash
  }).slice(0, 32)}`;
  const base = artifactBaseSchema.parse({
    schemaVersion: 2,
    evidenceId,
    role,
    problemContentHash,
    inputHash,
    promptVersion: identity.promptVersion,
    modelIdentity: identity.modelIdentity,
    sourceSnapshotHash,
    execution,
    payloadHash
  });
  return deepFreeze({ ...base, payload });
}

export function assertEvidenceArtifact<TPayload>(input: {
  readonly artifact: EvidenceArtifact<TPayload>;
  readonly payloadSchema: z.ZodType<TPayload>;
}): EvidenceArtifact<TPayload> {
  const { payload: rawPayload, ...rawBase } = input.artifact;
  const base = artifactBaseSchema.parse(rawBase);
  const payload = input.payloadSchema.parse(rawPayload);
  const expected = sealEvidenceArtifact({
    role: base.role,
    problemContentHash: base.problemContentHash,
    inputHash: base.inputHash,
    sourceSnapshotHash: base.sourceSnapshotHash,
    execution: base.execution,
    identity: {
      promptVersion: base.promptVersion,
      modelIdentity: base.modelIdentity
    },
    payloadSchema: input.payloadSchema,
    payload
  });
  if (
    base.evidenceId !== expected.evidenceId ||
    base.payloadHash !== expected.payloadHash
  ) {
    throw new Error("REVIEW_FLOW_EVIDENCE_IDENTITY_INVALID");
  }
  return expected;
}

export function hashCanonicalValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("REVIEW_FLOW_CANONICAL_VALUE_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("REVIEW_FLOW_CANONICAL_VALUE_INVALID");
}

export function deepFreeze<T>(value: T): T {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  // 平台 host 对象（AbortSignal、AbortController 等）不是普通可深度冻结的
  // plain config：递归冻结会破坏其内部状态（如后续 abort() 抛“只读属性”错误）。
  // 它们必须保持 opaque——不递归、也不调用 Object.freeze。普通 plain 对象与
  // 数组（Object.prototype/null 原型）仍按原语义整体深冻结，不放松不可变性。
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return value;
    }
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
