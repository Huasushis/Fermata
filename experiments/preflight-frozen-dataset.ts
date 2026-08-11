// 读取专用冻结数据集的只读预检：不注册用途、不打开 Gold、不发起任何模型调用。
import { loadReviewFlowEvaluationDataset } from "./lib/review-flow-evaluation-dataset.js";

const manifestPath =
  "/home/ubuntu/codex-urmotiv/Urmotiv/private/review-flow-gate-20260808/review-flow-v5-prediction/manifest.private.json";
const datasetPrivateRoot =
  "/home/ubuntu/codex-urmotiv/Urmotiv/private";
const containingWorkspace = "/home/ubuntu/codex-urmotiv";

const dataset = loadReviewFlowEvaluationDataset({
  manifestPath,
  privateRoot: datasetPrivateRoot,
  containingWorkspace,
  mode: "development_identity"
});
const safe = {
  schemaVersion: dataset.schemaVersion,
  purpose: dataset.purpose,
  loadMode: dataset.loadMode,
  caseCount: dataset.cases.length,
  manifestSha256: dataset.manifestSha256.slice(0, 16),
  bridgeCompletionSha256: dataset.bridgeCompletionSha256.slice(0, 16),
  datasetFingerprint: dataset.datasetFingerprint.slice(0, 16),
  anklangInputPolicy: dataset.anklangInputPolicy
};
// 不打印任何题面/答案/样本内容；只打印计数与摘要。
console.log(JSON.stringify(safe));