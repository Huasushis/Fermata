/**
 * 正式审题资格总门。
 *
 * 当前仓库还没有能回读并验证原始协议 completion、准确性 summary/completion、
 * 五条流水线各自人工标准与同一实验链完整性的可信聚合器。因此本提交不接受
 * 任何私有“自述证书”，也不读取证据路径；所有版本都固定 fail-closed。
 *
 * 后续只有在独立实现源证据回读、哈希链和逐 slot 准确性验证后，才能用新的
 * 审阅提交替换这里的恒拒绝实现。settings 或 models.yaml 都没有绕过开关。
 */
import type { AppConfig } from "./config";

export type ProductionEligibilityDecision =
  | {
      readonly eligible: false;
      readonly reason: "production_evidence_verifier_unimplemented";
    }
  | {
      /** 仅为 ReviewerWorker 的隔离单元测试保留接口形状；正式 verifier 永不返回。 */
      readonly eligible: true;
      readonly evidenceFingerprint: string;
    };

export const currentBlockedProductionExperimentVersion =
  "experiment-2026-08-difficulty-candidate-c-provider-v1-drain-v5";

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
