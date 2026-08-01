/**
 * 正式领取任务的启动门。
 *
 * models.yaml 只描述这次部署认可的配置版本；settings.json 才是操作员明确
 * 保存的运行状态。新部署不能因为默认档位存在就自动开始付费和领取私有题目：
 * 首次初始化固定关闭；已有设置还必须显式开启、版本精确相等、档位仍存在，
 * 并通过服务端生产资格证据门。
 */
import type { ModelsConfig, ProfileConfig } from "./config";
import type { ProductionEligibilityDecision } from "./production-eligibility";
import type { FermataPublicSettings } from "./urmotiv-schemas";

export type ReviewerActivationDecision =
  | { readonly active: true; readonly profile: ProfileConfig }
  | {
      readonly active: false;
      readonly reason:
        | "disabled"
        | "experiment_version_mismatch"
        | "profile_missing"
        | "production_evidence_rejected";
    };

/** 首次创建 settings.json 时始终关闭；必须由操作员通过管理接口明确开启。 */
export function createDefaultReviewerSettings(models: ModelsConfig): FermataPublicSettings {
  return {
    enabled: false,
    pollingIntervalSeconds: models.defaults.pollingIntervalSeconds,
    maximumConcurrentTasks: models.defaults.maximumConcurrentTasks,
    modelProfileName: models.defaults.modelProfileName,
    experimentVersion: models.experimentVersion
  };
}

/**
 * 先做不含密钥的设置/配置一致性判断，再惰性调用生产资格证据门。provider
 * 密钥的普通存在性检查仍由 ReviewerWorker 在这个门通过后执行。
 */
export function resolveReviewerActivation(
  settings: FermataPublicSettings,
  models: ModelsConfig,
  productionEligibility: () => ProductionEligibilityDecision
): ReviewerActivationDecision {
  if (!settings.enabled) {
    return { active: false, reason: "disabled" };
  }
  if (settings.experimentVersion !== models.experimentVersion) {
    return { active: false, reason: "experiment_version_mismatch" };
  }
  const profiles: Record<string, ProfileConfig | undefined> = models.profiles;
  const profile = profiles[settings.modelProfileName];
  if (profile === undefined) {
    return { active: false, reason: "profile_missing" };
  }
  if (!productionEligibility().eligible) {
    return { active: false, reason: "production_evidence_rejected" };
  }
  return { active: true, profile };
}
