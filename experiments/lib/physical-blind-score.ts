import { failPhysicalBlind } from "./physical-blind-common";
import { loadPhysicalBlindContentArtifact } from "./physical-blind-content";
import { loadPhysicalBlindPredictionArtifact } from "./physical-blind-inference";
import {
  physicalBlindProfile,
  type PhysicalBlindProfileName
} from "./physical-blind-profiles";

/**
 * 必须在评分进程读取 gold 前调用。普通 callback artifact 明确没有可信 checkpoint、
 * 代码/配置/模型/提示词身份和 EOF completion，因此即使样本齐全也固定拒绝。
 */
export function assertPhysicalBlindPredictionScorable(input: {
  readonly contentDocument: string;
  readonly predictionDocument: string;
  readonly profileName: PhysicalBlindProfileName;
}): never {
  const profile = physicalBlindProfile(input.profileName);
  const content = loadPhysicalBlindContentArtifact(input.contentDocument);
  const predictions = loadPhysicalBlindPredictionArtifact({
    document: input.predictionDocument,
    content,
    predictionSchema: profile.predictionSchema
  });
  if (!content.productionEligible) {
    failPhysicalBlind(content.sourceIneligibilityReasonCode);
  }
  if (
    !predictions.executionEvidence.productionEligible ||
    !predictions.executionEvidence.eofVerified ||
    !predictions.executionEvidence.trustedCheckpointBound
  ) {
    failPhysicalBlind("BLIND_PREDICTION_NOT_SCORABLE");
  }
  return failPhysicalBlind("BLIND_TRUSTED_EXECUTION_ADAPTER_REQUIRED");
}

/** 当前无可信 prediction completion；正式评分固定在读取 gold 前失败关闭。 */
export function scorePhysicalBlindArtifacts(input: {
  readonly contentDocument: string;
  readonly goldDocument: string;
  readonly predictionDocument: string;
  readonly profileName: PhysicalBlindProfileName;
}): never {
  void input.goldDocument;
  return assertPhysicalBlindPredictionScorable({
    contentDocument: input.contentDocument,
    predictionDocument: input.predictionDocument,
    profileName: input.profileName
  });
}
