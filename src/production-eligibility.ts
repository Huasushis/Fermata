/**
 * 正式审题资格总门。
 *
 * 当前仓库还没有能回读并验证原始协议 completion、准确性 summary/completion、
 * 11 个角色各自人工标准与同一实验链完整性的可信聚合器。因此本提交不接受
 * 任何私有“自述证书”，也不读取证据路径；所有版本都固定 fail-closed。
 *
 * 后续只有在独立实现源证据回读、哈希链和逐 slot 准确性验证后，才能用新的
 * 审阅提交替换这里的恒拒绝实现。settings 或 models.yaml 都没有绕过开关。
 */
import type { AppConfig } from "./config";

declare const productionReviewGrantBrand: unique symbol;

/** 不可序列化、不可由普通对象仿造的进程内生产资格能力。 */
export interface ProductionReviewGrant {
  readonly [productionReviewGrantBrand]: true;
}

export interface ProductionReviewGrantClaims {
  readonly profileName: string;
  readonly experimentVersion: string;
  readonly expectedRunnerIdentity: string;
  readonly engineBuildFingerprint: string;
  readonly evidenceFingerprint: string;
}

const productionReviewGrantClaims = new WeakMap<object, ProductionReviewGrantClaims>();

/**
 * 当前模块故意没有签发入口；未来源证据聚合器必须在本模块内完成校验后才能
 * 登记 grant。这里只提供统一验真，普通字符串、展开对象和同形对象都返回 null。
 */
export function inspectProductionReviewGrant(
  candidate: unknown,
  expected: Pick<ProductionReviewGrantClaims, "profileName" | "experimentVersion"> &
    Partial<Pick<ProductionReviewGrantClaims, "expectedRunnerIdentity" | "engineBuildFingerprint">>
): ProductionReviewGrantClaims | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const claims = productionReviewGrantClaims.get(candidate);
  if (
    claims === undefined ||
    claims.profileName !== expected.profileName ||
    claims.experimentVersion !== expected.experimentVersion ||
    (expected.expectedRunnerIdentity !== undefined &&
      claims.expectedRunnerIdentity !== expected.expectedRunnerIdentity) ||
    (expected.engineBuildFingerprint !== undefined &&
      claims.engineBuildFingerprint !== expected.engineBuildFingerprint)
  ) {
    return null;
  }
  return claims;
}

export type ProductionEligibilityDecision =
  | {
      readonly eligible: false;
      readonly reason: "production_evidence_verifier_unimplemented";
    }
  | {
      readonly eligible: true;
      readonly grant: ProductionReviewGrant;
    };

export const currentBlockedProductionExperimentVersion =
  "experiment-2026-08-review-flow-historical-rubric-v1-eof-receipt-v2";

export interface ProductionEligibilityVerifier {
  verify(profileName: string): ProductionEligibilityDecision;
}

export function productionEligibilityBlocked(): ProductionEligibilityDecision {
  return {
    eligible: false,
    reason: "production_evidence_verifier_unimplemented"
  };
}

/**
 * 参数只保留正式装配接口的形状；故意不读取 config、profile 或任何私有文件。
 * 即使调用者传入未来版本或任意路径，也不存在可达的 eligible=true 分支。
 */
export function createProductionEligibilityVerifier(
  _config: AppConfig
): ProductionEligibilityVerifier {
  return {
    verify: (_profileName) => productionEligibilityBlocked()
  };
}
