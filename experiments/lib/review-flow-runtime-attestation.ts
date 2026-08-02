import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { EvaluationCodeIdentity } from "./evaluation-code-identity";

export const reviewFlowRuntimeAttestationEnvironmentKey =
  "FERMATA_REVIEW_FLOW_RUNTIME_ATTESTATION";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const runtimeVersionSchema = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,119}$/u);

export const reviewFlowRuntimeIdentitySchema = z
  .object({
    nodeVersion: runtimeVersionSchema,
    platform: runtimeVersionSchema,
    arch: runtimeVersionSchema,
    packageLockSha256: digestSchema,
    nodeExecutableSha256: digestSchema,
    nodeExecutableByteLength: z.number().int().positive(),
    dependencyBundleSha256: digestSchema,
    dependencyFileCount: z.number().int().positive(),
    dependencyByteLength: z.number().int().positive(),
    snapshotSha256: digestSchema,
    snapshotFileCount: z.number().int().positive(),
    packages: z
      .array(
        z
          .object({
            name: z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u),
            version: runtimeVersionSchema,
            sha256: digestSchema,
            fileCount: z.number().int().positive(),
            byteLength: z.number().int().positive()
          })
          .strict()
      )
      .min(1)
      .max(64)
      .superRefine((packages, context) => {
        if (new Set(packages.map((entry) => entry.name)).size !== packages.length) {
          context.addIssue({ code: "custom", message: "runtime package 重复。" });
        }
      }),
    trustModel: z.literal(
      "trusted_bootstrap_same_uid_non_adversarial_trusted_host_system_runtime_unbound_v1"
    )
  })
  .strict()
  .superRefine((runtime, context) => {
    const packageFileCount = runtime.packages.reduce(
      (sum, package_) => sum + package_.fileCount,
      0
    );
    const packageByteLength = runtime.packages.reduce(
      (sum, package_) => sum + package_.byteLength,
      0
    );
    if (
      packageFileCount !== runtime.dependencyFileCount ||
      packageByteLength !== runtime.dependencyByteLength ||
      runtime.snapshotFileCount <= runtime.dependencyFileCount
    ) {
      context.addIssue({ code: "custom", message: "runtime 聚合身份不一致。" });
    }
  });

export type ReviewFlowRuntimeIdentity = z.infer<
  typeof reviewFlowRuntimeIdentitySchema
>;

const codeIdentitySchema = z
  .object({
    codeVersion: z.string().regex(/^[0-9a-f]{40}$/u),
    runnerSha256: digestSchema,
    dependencyCodeSha256: digestSchema,
    dependencyFileCount: z.number().int().positive(),
    productionDependencyCodeSha256: digestSchema,
    productionDependencyFileCount: z.number().int().positive()
  })
  .strict();

const attestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    launchNonce: z.string().regex(/^[0-9a-f]{64}$/u),
    snapshotRoot: z.string().min(1).max(4_096),
    originRepositoryRoot: z.string().min(1).max(4_096),
    originWorkspaceRoot: z.string().min(1).max(4_096),
    codeIdentity: codeIdentitySchema,
    runtimeIdentity: reviewFlowRuntimeIdentitySchema
  })
  .strict();

export interface ReviewFlowRuntimeAttestation {
  readonly codeIdentity: EvaluationCodeIdentity;
  readonly runtimeIdentity: ReviewFlowRuntimeIdentity;
  readonly originRepositoryRoot: string;
  readonly originWorkspaceRoot: string;
  readonly originPrivateRoot: string;
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent !== "" &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent);
}

function stableFileSha256(path: string): { readonly sha256: string; readonly byteLength: number } {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("REVIEW_FLOW_RUNTIME_ATTESTATION_INVALID");
  }
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.uid !== after.uid ||
    before.gid !== after.gid ||
    before.nlink !== after.nlink ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error("REVIEW_FLOW_RUNTIME_ATTESTATION_INVALID");
  }
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength
  };
}

/**
 * 只接受 bootstrap 注入的严格 attestation，并证明当前 TS 确实从其代码快照、
 * 复制后的 Node 可执行文件运行。路径只在内存里用于打开正式 private 根，不进入报告。
 */
export function loadReviewFlowRuntimeAttestation(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly currentRepositoryRoot: string;
  readonly currentExecutable: string;
}): ReviewFlowRuntimeAttestation {
  try {
    const serialized = input.environment[reviewFlowRuntimeAttestationEnvironmentKey];
    delete input.environment[reviewFlowRuntimeAttestationEnvironmentKey];
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
      throw new Error("invalid");
    }
    const parsed = attestationSchema.parse(JSON.parse(serialized) as unknown);
    if (
      !isAbsolute(parsed.snapshotRoot) ||
      !isAbsolute(parsed.originRepositoryRoot) ||
      !isAbsolute(parsed.originWorkspaceRoot) ||
      parsed.codeIdentity.codeVersion !== input.environment.EVAL_CODE_VERSION
    ) {
      throw new Error("invalid");
    }
    const snapshotRoot = realpathSync(parsed.snapshotRoot);
    const currentRepositoryRoot = realpathSync(input.currentRepositoryRoot);
    const currentExecutable = realpathSync(input.currentExecutable);
    const originRepositoryRoot = realpathSync(parsed.originRepositoryRoot);
    const originWorkspaceRoot = realpathSync(parsed.originWorkspaceRoot);
    if (
      snapshotRoot !== currentRepositoryRoot ||
      currentExecutable !== resolve(snapshotRoot, "runtime/node") ||
      !isStrictDescendant(originWorkspaceRoot, originRepositoryRoot) ||
      originRepositoryRoot === snapshotRoot
    ) {
      throw new Error("invalid");
    }
    const executable = stableFileSha256(currentExecutable);
    if (
      executable.sha256 !== parsed.runtimeIdentity.nodeExecutableSha256 ||
      executable.byteLength !== parsed.runtimeIdentity.nodeExecutableByteLength ||
      process.versions.node !== parsed.runtimeIdentity.nodeVersion ||
      process.platform !== parsed.runtimeIdentity.platform ||
      process.arch !== parsed.runtimeIdentity.arch
    ) {
      throw new Error("invalid");
    }
    return Object.freeze({
      codeIdentity: Object.freeze(parsed.codeIdentity),
      runtimeIdentity: Object.freeze(parsed.runtimeIdentity),
      originRepositoryRoot,
      originWorkspaceRoot,
      originPrivateRoot: resolve(originRepositoryRoot, "private")
    });
  } catch {
    throw new Error("REVIEW_FLOW_RUNTIME_ATTESTATION_INVALID");
  }
}
