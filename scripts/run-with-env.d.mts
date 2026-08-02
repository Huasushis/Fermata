export const reviewFlowEvaluationModeFlag: "--review-flow-evaluation";
export const reviewFlowEvaluationBootstrapPath: string;
export const allowedReviewFlowEvaluationRunEnvironmentKeys: readonly string[];
export interface RunWithEnvSignalController {
  readonly closed: boolean;
  request(signal: "SIGINT" | "SIGTERM" | "SIGHUP"): void;
  attach(child: { kill(signal: NodeJS.Signals): unknown }): void;
}
export function createRunWithEnvSignalController(): RunWithEnvSignalController;
export function installRunWithEnvSignalHandlers(
  controller: RunWithEnvSignalController,
  processTarget?: Pick<NodeJS.Process, "on" | "off">
): () => void;
