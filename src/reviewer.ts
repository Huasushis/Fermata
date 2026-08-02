/**
 * 主循环：定时轮询 claim -> 严格构造完整题目快照 -> 跑 11 个相互隔离并带
 * EOF receipt 的审题角色 -> 只有完整且绑定生产准确性证据时才 complete。每个任务
 * 独立续租；单个任务失败不影响其它任务和下一轮轮询；wake() 可以跳过当前等待
 * 立即触发一轮轮询；stop() 优雅停机。
 *
 * "现在生效的设置"（enabled/pollingIntervalSeconds/maximumConcurrentTasks/
 * modelProfileName/experimentVersion）都从 SettingsStore 实时读取，不在构造时
 * 固定下来——这样通过管理端口改了设置之后，下一轮轮询（或者调用 wake() 之后）
 * 马上生效，不需要重启进程。
 *
 * 历史的难度/思维/代码/verdict 路径不再由 worker 引用；离线实验可独立使用
 * 旧模块，但生产构建没有切回旧审题流程的开关。
 */
import { randomUUID } from "node:crypto";
import {
  getProviderCredentials,
  missingProvidersForProfile,
  type AppConfig,
  type ModelSpec,
  type ProfileConfig
} from "./config";
import type { FetchLike } from "./llm";
import { logError, logInfo, logWarn } from "./logger";
import type { DifficultyAnchor } from "./pipelines/difficulty";
import type { PipelineModelConfig } from "./pipelines/types";
import type { SettingsStoreLike } from "./settings-store";
import { resolveReviewerActivation } from "./reviewer-activation";
import {
  productionEligibilityBlocked,
  type ProductionEligibilityDecision,
  type ProductionReviewGrant,
  type ProductionReviewGrantClaims
} from "./production-eligibility";
import {
  isAuthenticationError,
  isForbiddenError,
  isRetryableUrmotivDeliveryError,
  isTaskConflictError,
  URMOTIV_RETRY_DEADLINE_SAFETY_MS,
  UrmotivApiError,
  UrmotivNetworkError,
  type RenewRobotReviewTaskRequest,
  type UrmotivClientLike
} from "./urmotiv-client";
import type {
  ClaimRobotReviewTasksResponse,
  RobotReviewTask
} from "./urmotiv-schemas";
import {
  consumeReviewFlowSubmission,
  runReviewEvidenceFlowOutcome
} from "./review-flow/orchestrator";
import {
  createReviewFlowLlmBundle,
  preflightReviewFlowProductionGrant,
  type ReviewFlowModelConfigs
} from "./review-flow/llm-roles";
import { buildReviewFlowTaskSource } from "./review-flow/task-source";

export interface ReviewerStatus {
  readonly workerRunning: boolean;
  readonly activeTasks: number;
}

export interface ReviewerWorkerOptions {
  readonly urmotivClient: UrmotivClientLike;
  readonly settingsStore: SettingsStoreLike;
  readonly appConfig: AppConfig;
  readonly anchors: readonly DifficultyAnchor[];
  /** 每次续租请求的租期长度（秒），默认 300，和契约的默认值一致。 */
  readonly leaseSeconds?: number;
  /** 传给所有流水线的 LLM 请求用的 fetch，默认全局 fetch；测试用来注入假实现。 */
  readonly fetch?: FetchLike;
  /** 服务端生产资格证据门；未注入时固定拒绝，不能因测试/装配遗漏而放行。 */
  readonly productionEligibility?: (profileName: string) => ProductionEligibilityDecision;
}

interface InFlightTask {
  readonly assignmentId: string;
  readonly abortController: AbortController;
  leaseExpiresAt: string;
  renewalTimer: NodeJS.Timeout | null;
  renewalPromise: Promise<void> | null;
  /**
   * 没有拿到 HTTP 响应，或只收到 429/5xx 的续租仍是同一个逻辑操作；短间隔
   * 重试必须逐字段复用这份输入。成功或收到不可重试的确定响应后才能清掉，下一
   * 轮正常续租才生成新 UUID。
   */
  renewalOperation: RenewRobotReviewTaskRequest | null;
  /** 续租发现任务已经不属于我们时置为 true，处理逻辑会尽快放弃、不再提交。 */
  abandoned: boolean;
}

export class ReviewerWorker {
  readonly #urmotivClient: UrmotivClientLike;
  readonly #settingsStore: SettingsStoreLike;
  readonly #appConfig: AppConfig;
  readonly #anchors: readonly DifficultyAnchor[];
  readonly #leaseSeconds: number;
  readonly #fetch: FetchLike | undefined;
  readonly #productionEligibility: (profileName: string) => ProductionEligibilityDecision;

  #running = false;
  #stopping = false;
  #pollTimer: NodeJS.Timeout | null = null;
  #pollPromise: Promise<void> | null = null;
  readonly #inFlight = new Map<string, InFlightTask>();
  readonly #taskPromises = new Map<string, Promise<void>>();

  public constructor(options: ReviewerWorkerOptions) {
    this.#urmotivClient = options.urmotivClient;
    this.#settingsStore = options.settingsStore;
    this.#appConfig = options.appConfig;
    this.#anchors = options.anchors;
    this.#leaseSeconds = options.leaseSeconds ?? 300;
    this.#fetch = options.fetch;
    this.#productionEligibility = options.productionEligibility ?? productionEligibilityBlocked;
  }

  public start(): void {
    if (this.#running || this.#stopping) {
      return;
    }
    this.#running = true;
    this.#stopping = false;
    this.schedulePoll(0);
  }

  public async stop(): Promise<void> {
    this.#running = false;
    this.#stopping = true;
    if (this.#pollTimer !== null) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }

    // 已经发出的 claim 无法安全取消；先等这一轮收束，确保它领取到的任务也进入
    // #taskPromises，再等待所有在途任务自然完成。等待期间不清续租计时器，避免
    // 长时间的模型请求在停机过程中丢失租约。
    if (this.#pollPromise !== null) {
      await this.#pollPromise;
    }
    const pending = [...this.#taskPromises.values()];
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }

    // 正常情况下 processTask 的 finally 已经清理完毕；这里兜底清除残留计时器，
    // 避免异常路径留下会阻止进程退出的定时器。
    for (const inFlight of this.#inFlight.values()) {
      this.clearRenewal(inFlight);
    }
    this.#stopping = false;
  }

  /** 跳过当前的等待，立即触发一轮轮询；如果已经停机则什么都不做。 */
  public wake(): void {
    if (!this.#running || this.#stopping) {
      return;
    }
    // 已经在轮询时无需再并发发起一轮；当前轮询结束后仍会按设置安排下一次。
    if (this.#pollPromise !== null) {
      return;
    }
    if (this.#pollTimer !== null) {
      clearTimeout(this.#pollTimer);
    }
    this.schedulePoll(0);
  }

  public getStatus(): ReviewerStatus {
    return { workerRunning: this.#running, activeTasks: this.#inFlight.size };
  }

  private schedulePoll(delayMs: number): void {
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      if (!this.#running || this.#stopping) {
        return;
      }
      this.#pollPromise = this.runPoll();
    }, delayMs);
  }

  private async runPoll(): Promise<void> {
    try {
      await this.pollOnce();
    } catch (error) {
      logError("轮询过程出现未捕获异常", error);
    } finally {
      this.#pollPromise = null;
      if (this.#running && !this.#stopping) {
        const { pollingIntervalSeconds } = this.#settingsStore.get().settings;
        this.schedulePoll(pollingIntervalSeconds * 1_000);
      }
    }
  }

  private async pollOnce(): Promise<void> {
    const { settings } = this.#settingsStore.get();
    let productionDecision: ProductionEligibilityDecision | undefined;
    const readProductionEligibility = (): ProductionEligibilityDecision => {
      productionDecision ??= this.#productionEligibility(settings.modelProfileName);
      return productionDecision;
    };
    const activation = resolveReviewerActivation(
      settings,
      this.#appConfig.models,
      readProductionEligibility
    );
    if (!activation.active) {
      if (activation.reason === "experiment_version_mismatch") {
        logWarn("运行期 experimentVersion 与当前配置不一致，拒绝领取任务；请由操作员核对后明确更新设置");
      } else if (activation.reason === "profile_missing") {
        logWarn("当前设置的 modelProfileName 在 config/models.yaml 里不存在，跳过这一轮轮询", {
          modelProfileName: settings.modelProfileName
        });
      } else if (activation.reason === "production_evidence_rejected") {
        const decision = readProductionEligibility();
        logWarn("生产资格证据未通过，拒绝领取任务", {
          reason: decision.eligible ? "evidence_invalid" : decision.reason
        });
      }
      return;
    }

    const availableSlots = settings.maximumConcurrentTasks - this.#inFlight.size;
    if (availableSlots <= 0) {
      return;
    }

    const profile = activation.profile;
    const missing = missingProvidersForProfile(this.#appConfig, profile);
    if (missing.length > 0) {
      logWarn("当前模型档位缺少 provider 密钥，跳过这一轮轮询", { missing: missing.join(",") });
      return;
    }

    // activation 只证明 grant 属于当前 profile/version；在真正领取私有任务前，
    // 还必须用本进程实际装配的 11 个模型槽位、凭据、anchors、传输模式和构建
    // 摘要重算 runner 身份并完整验真。预检不创建角色，也不会发出模型请求。
    let productionClaims: ProductionReviewGrantClaims | null = null;
    try {
      productionClaims = preflightReviewFlowProductionGrant({
        models: this.resolveReviewFlowModelConfigs(profile),
        difficultyAnchors: this.#anchors,
        profileName: settings.modelProfileName,
        experimentVersion: settings.experimentVersion,
        engineBuildFingerprint: activation.productionClaims.engineBuildFingerprint,
        productionGrant: activation.productionGrant
      });
    } catch {
      // 配置或构建摘要不满足 runner 身份契约时同样 fail-closed；错误细节可能
      // 含 provider 配置，不能写进日志。
      productionClaims = null;
    }
    if (productionClaims === null) {
      logWarn("生产资格证据与当前审题 runner 不匹配，拒绝领取任务");
      return;
    }

    let claimed: ClaimRobotReviewTasksResponse;
    try {
      claimed = await this.#urmotivClient.claim({
        maximumTasks: Math.min(availableSlots, 10),
        leaseSeconds: this.#leaseSeconds
      });
    } catch (error) {
      if (isAuthenticationError(error)) {
        logError("机器人令牌认证失败，请检查 URMOTIV_ROBOT_TOKEN 是否有效", error);
      } else {
        logError("领取任务失败", error);
      }
      return;
    }

    const claimedAssignmentIds = new Set<string>();
    for (const task of claimed.items) {
      if (
        claimedAssignmentIds.has(task.assignmentId)
        || this.#inFlight.has(task.assignmentId)
        || this.#taskPromises.has(task.assignmentId)
      ) {
        logWarn("领取响应包含重复或仍在途的任务，跳过重复启动", {
          assignmentId: task.assignmentId
        });
        continue;
      }
      claimedAssignmentIds.add(task.assignmentId);

      const leaseExpiresAtMs = Date.parse(task.leaseExpiresAt);
      if (!Number.isFinite(leaseExpiresAtMs) || leaseExpiresAtMs <= Date.now()) {
        logWarn("领取到的任务租约已经失效，拒绝启动处理流程", {
          assignmentId: task.assignmentId
        });
        continue;
      }

      const promise: Promise<void> = this.processTask(
        task,
        settings.modelProfileName,
        settings.experimentVersion,
        profile,
        activation.productionGrant,
        productionClaims
      ).finally(
        () => {
          // 只清理自己登记的 promise；即使以后启动策略变化，也不能让旧任务的
          // finally 误删同一 assignmentId 下较新的任务记录。
          if (this.#taskPromises.get(task.assignmentId) === promise) {
            this.#taskPromises.delete(task.assignmentId);
          }
        }
      );
      this.#taskPromises.set(task.assignmentId, promise);
    }
  }

  private async processTask(
    task: RobotReviewTask,
    modelProfileName: string,
    experimentVersion: string,
    profile: ProfileConfig,
    productionGrant: ProductionReviewGrant,
    productionClaims: ProductionReviewGrantClaims
  ): Promise<void> {
    const inFlight: InFlightTask = {
      assignmentId: task.assignmentId,
      abortController: new AbortController(),
      leaseExpiresAt: task.leaseExpiresAt,
      renewalTimer: null,
      renewalPromise: null,
      renewalOperation: null,
      abandoned: false
    };
    this.#inFlight.set(task.assignmentId, inFlight);
    this.scheduleRenewal(inFlight);

    try {
      logInfo("开始处理审题任务", { problemId: task.problem.id, revision: task.problem.revision });
      const taskSource = buildReviewFlowTaskSource(task, {
        duplicateSimilarityRejectThreshold:
          this.#appConfig.models.thresholds.duplicateSimilarityReject
      });
      const trustedRunner = createReviewFlowLlmBundle({
        models: this.resolveReviewFlowModelConfigs(
          profile,
          inFlight.abortController.signal
        ),
        difficultyAnchors: this.#anchors,
        profileName: modelProfileName,
        experimentVersion,
        engineBuildFingerprint: productionClaims.engineBuildFingerprint,
        productionGrant
      });
      const outcome = await runReviewEvidenceFlowOutcome({
        taskSource,
        trustedRunner,
        executionContext: {
          schemaVersion: 1,
          runId: randomUUID(),
          assignmentId: task.assignmentId,
          expectedRound: task.problem.reviewRound
        }
      });
      if (outcome.status === "incomplete") {
        logWarn("审题证据工作流不完整，不提交审核意见", {
          problemId: task.problem.id,
          failureId: outcome.failure.failureId,
          failureKind: outcome.failure.failureKind,
          failedRoles: outcome.failure.failedRoles
            .map((failure) => failure.role)
            .join(","),
          transportAttemptCount: outcome.failure.failedRoles.reduce(
            (sum, failure) => sum + failure.transportAttemptCount,
            0
          )
        });
        return;
      }
      if (!outcome.decision.executionEligible) {
        logWarn("审题结果没有同时绑定生产传输与准确性证据，不提交审核意见", {
          problemId: task.problem.id,
          decisionId: outcome.decision.decisionId
        });
        return;
      }
      const completionLog: Readonly<Record<string, string | number | boolean>> = {
        decisionId: outcome.decision.decisionId,
        policyHash: outcome.decision.policyHash,
        evidenceCount: outcome.decision.evidenceIds.length
      };

      if (inFlight.abandoned) {
        logWarn("综合流水线跑完时任务已经被判定放弃，不再提交", { problemId: task.problem.id });
        return;
      }

      await this.finishRenewalBeforeCompletion(inFlight);
      if (inFlight.abandoned) {
        logWarn("提交前续租确认任务已经不属于我们，不再提交", {
          problemId: task.problem.id
        });
        return;
      }

      const review = consumeReviewFlowSubmission(outcome.decision, {
        taskSource,
        assignmentId: task.assignmentId,
        problemContentHash: task.problem.contentHash,
        problemRevision: task.problem.revision,
        expectedRound: task.problem.reviewRound,
        tagCatalogVersion: task.tagCatalog.version,
        accuracyEvidenceFingerprint: productionClaims.evidenceFingerprint
      });

      const completion = await this.#urmotivClient.complete(task.assignmentId, {
        requestId: randomUUID(),
        expectedLeaseExpiresAt: inFlight.leaseExpiresAt,
        expectedProblemRevision: task.problem.revision,
        expectedTagCatalogVersion: task.tagCatalog.version,
        experimentVersion,
        modelProfileName,
        review
      });

      logInfo("完成审题任务", {
        problemId: task.problem.id,
        problemStatus: completion.problemStatus,
        ...completionLog
      });
    } catch (error) {
      if (!inFlight.abandoned) {
        this.logTaskFailure(task, error);
      }
    } finally {
      this.clearRenewal(inFlight);
      // 与 #taskPromises 的清理一样按对象身份删除，避免旧流程的 finally 清掉
      // 同一 assignmentId 下后来登记的续租状态。
      if (this.#inFlight.get(task.assignmentId) === inFlight) {
        this.#inFlight.delete(task.assignmentId);
      }
    }
  }

  private resolveReviewFlowModelConfigs(
    profile: ProfileConfig,
    signal?: AbortSignal
  ): ReviewFlowModelConfigs {
    const specs = profile.reviewFlow;
    return {
      solver: this.resolveModelConfig(specs.solver, signal),
      solution_analyst: this.resolveModelConfig(specs.solutionAnalyst, signal),
      technical_auditor: this.resolveModelConfig(specs.technicalAuditor, signal),
      difficulty: this.resolveModelConfig(specs.difficulty, signal),
      editorial_judge: this.resolveModelConfig(specs.editorialJudge, signal),
      contest_fit: this.resolveModelConfig(specs.contestFit, signal),
      originality: this.resolveModelConfig(specs.originality, signal),
      tags: this.resolveModelConfig(specs.tags, signal),
      critic: this.resolveModelConfig(specs.critic, signal),
      adversary: this.resolveModelConfig(specs.adversary, signal),
      adjudicator: this.resolveModelConfig(specs.adjudicator, signal)
    };
  }

  private logTaskFailure(task: RobotReviewTask, error: unknown): void {
    if (isTaskConflictError(error)) {
      logWarn("任务已经不属于我们（租约过期或版本变化），放弃且不重试", {
        problemId: task.problem.id,
        status: (error as UrmotivApiError).status
      });
      return;
    }
    if (isForbiddenError(error)) {
      logWarn("没有权限处理这个任务，放弃且不重试", { problemId: task.problem.id });
      return;
    }
    if (isAuthenticationError(error)) {
      logError("提交审核意见时机器人令牌认证失败", error, { problemId: task.problem.id });
      return;
    }
    if (isRetryableUrmotivDeliveryError(error)) {
      const message = error instanceof UrmotivNetworkError
        ? "提交审核意见的结果不确定；当前任务不会更换请求标识重新提交"
        : "提交审核意见仍未完成；当前任务不会更换请求标识重新提交";
      logError(message, error, {
        problemId: task.problem.id
      });
      return;
    }
    logError("处理审题任务失败", error, { problemId: task.problem.id });
  }

  private resolveModelConfig(
    spec: ModelSpec,
    signal?: AbortSignal
  ): PipelineModelConfig {
    const credentials = getProviderCredentials(this.#appConfig, spec.provider);
    if (credentials === undefined) {
      // pollOnce 已经用 missingProvidersForProfile 提前检查过，正常不会走到这里；
      // 保留这个检查是为了在契约/配置被意外改动时给出清楚的错误而不是空指针异常。
      throw new Error(`provider "${spec.provider}" 没有配置密钥。`);
    }
    return {
      spec,
      credentials,
      runtime: {
        firstOutputTimeoutMs: this.#appConfig.models.timeouts.llmFirstOutputMs,
        outputIdleTimeoutMs: this.#appConfig.models.timeouts.llmOutputIdleMs,
        maximumDurationMs: this.#appConfig.models.timeouts.llmMaximumDurationMs,
        maxAttempts: this.#appConfig.models.retry.maxAttempts,
        baseDelayMs: this.#appConfig.models.retry.baseDelayMs,
        fetch: this.#fetch,
        signal
      }
    };
  }

  private scheduleRenewal(inFlight: InFlightTask): void {
    // 在租期约三分之一处续租，给网络失败后的短间隔重试留出充分余量。
    const renewIntervalMs = Math.max(
      5_000,
      Math.floor((this.#leaseSeconds * 1_000) / 3)
    );
    this.scheduleRenewalAfter(inFlight, renewIntervalMs);
  }

  private scheduleRenewalRetry(inFlight: InFlightTask): boolean {
    const normalRetryMs = Math.max(
      1_000,
      Math.min(30_000, Math.floor((this.#leaseSeconds * 1_000) / 10))
    );
    const leaseExpiresAtMs = Date.parse(inFlight.leaseExpiresAt);
    const remainingLeaseMs = leaseExpiresAtMs - Date.now();
    const requestTimeoutMs = this.#urmotivClient.requestTimeoutMs;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1_000) {
      return false;
    }
    const minimumDeliveryBudgetMs =
      requestTimeoutMs + URMOTIV_RETRY_DEADLINE_SAFETY_MS;
    if (!Number.isFinite(remainingLeaseMs) || remainingLeaseMs <= minimumDeliveryBudgetMs + 1_000) {
      return false;
    }
    const latestSafeDelayMs = remainingLeaseMs - minimumDeliveryBudgetMs;
    const retryMs =
      Math.max(
        1_000,
        Math.min(normalRetryMs, Math.floor(remainingLeaseMs / 4), latestSafeDelayMs)
      );
    this.scheduleRenewalAfter(inFlight, retryMs);
    return true;
  }

  private hasFullRenewalDeliveryBudget(inFlight: InFlightTask): boolean {
    const operation = inFlight.renewalOperation;
    if (operation === null) {
      return true;
    }
    const requestTimeoutMs = this.#urmotivClient.requestTimeoutMs;
    const leaseExpiresAtMs = Date.parse(operation.expectedLeaseExpiresAt);
    return Number.isFinite(requestTimeoutMs)
      && requestTimeoutMs >= 1_000
      && Number.isFinite(leaseExpiresAtMs)
      && leaseExpiresAtMs - Date.now()
        > requestTimeoutMs + URMOTIV_RETRY_DEADLINE_SAFETY_MS;
  }

  private scheduleRenewalAfter(
    inFlight: InFlightTask,
    delayMs: number
  ): void {
    inFlight.renewalTimer = setTimeout(() => {
      inFlight.renewalTimer = null;
      const renewalPromise = this.renewTask(inFlight)
        .catch((error: unknown) => {
          logError("续租时出现未捕获异常", error, {
            assignmentId: inFlight.assignmentId
          });
        })
        .finally(() => {
          if (inFlight.renewalPromise === renewalPromise) {
            inFlight.renewalPromise = null;
          }
        });
      inFlight.renewalPromise = renewalPromise;
    }, delayMs);
  }

  private async finishRenewalBeforeCompletion(
    inFlight: InFlightTask
  ): Promise<void> {
    // 不再安排新的续租；如果已有续租请求在途，必须先等响应并采用最新租约时间，
    // 否则 complete 可能携带旧值，被服务端当成过期任务拒绝。
    this.clearRenewal(inFlight);
    const renewalPromise = inFlight.renewalPromise;
    if (renewalPromise !== null) {
      await renewalPromise;
    }
    // 在途续租成功或普通失败时可能刚安排了下一次定时器，提交前一并清掉。
    this.clearRenewal(inFlight);
    if (inFlight.renewalOperation !== null) {
      logWarn("提交前续租结果仍不确定，停止当前任务且不更换请求标识提交", {
        assignmentId: inFlight.assignmentId
      });
      this.abandonTask(inFlight);
    }
  }

  private async renewTask(inFlight: InFlightTask): Promise<void> {
    if (inFlight.abandoned || !this.#inFlight.has(inFlight.assignmentId)) {
      return;
    }
    if (!this.hasFullRenewalDeliveryBudget(inFlight)) {
      logWarn("续租重试开始前安全预算已经不足，停止当前任务", {
        assignmentId: inFlight.assignmentId
      });
      this.abandonTask(inFlight);
      return;
    }
    const operation = inFlight.renewalOperation ?? {
      requestId: randomUUID(),
      expectedLeaseExpiresAt: inFlight.leaseExpiresAt,
      leaseSeconds: this.#leaseSeconds
    };
    inFlight.renewalOperation = operation;
    try {
      const result = await this.#urmotivClient.renew(inFlight.assignmentId, operation);
      inFlight.renewalOperation = null;
      inFlight.leaseExpiresAt = result.leaseExpiresAt;
      // processTask 可能在这次 await 期间已经完成并把任务从 #inFlight 里删掉了
      // （它自己的 finally 会调用 clearRenewal，但没法取消一个已经在飞行中的
      // renew() 请求）。这里必须重新检查一遍 #inFlight，否则会为一个已经结束的
      // 任务继续挂一个新的续租定时器，永远续下去。
      if (!inFlight.abandoned && this.#inFlight.has(inFlight.assignmentId)) {
        this.scheduleRenewal(inFlight);
      }
    } catch (error) {
      if (isRetryableUrmotivDeliveryError(error)) {
        logError("续租暂未完成，将在安全租约预算内复用同一请求标识重试", error, {
          assignmentId: inFlight.assignmentId
        });
        if (
          !inFlight.abandoned
          && this.#inFlight.has(inFlight.assignmentId)
          && this.scheduleRenewalRetry(inFlight)
        ) {
          return;
        }
        logWarn("续租仍未完成且安全重试预算不足，停止当前任务", {
          assignmentId: inFlight.assignmentId
        });
        this.abandonTask(inFlight);
        return;
      }
      // 确定的非重试 HTTP 响应和本地契约错误不能当作暂时故障继续复用。
      inFlight.renewalOperation = null;
      if (isTaskConflictError(error)) {
        logWarn("续租失败：任务已经不属于我们，标记放弃", { assignmentId: inFlight.assignmentId });
        this.abandonTask(inFlight);
        return;
      }
      if (isForbiddenError(error)) {
        logWarn("续租失败：没有继续处理这个任务的权限，标记放弃", {
          assignmentId: inFlight.assignmentId
        });
        this.abandonTask(inFlight);
        return;
      }
      if (isAuthenticationError(error)) {
        logError("续租失败：机器人令牌认证失败，停止当前任务", error, {
          assignmentId: inFlight.assignmentId
        });
        this.abandonTask(inFlight);
        return;
      }
      logError("续租收到确定失败或本地协议错误，停止当前任务且不自动重试", error, {
        assignmentId: inFlight.assignmentId
      });
      this.abandonTask(inFlight);
    }
  }

  private clearRenewal(inFlight: InFlightTask): void {
    if (inFlight.renewalTimer !== null) {
      clearTimeout(inFlight.renewalTimer);
      inFlight.renewalTimer = null;
    }
  }

  private abandonTask(inFlight: InFlightTask): void {
    if (inFlight.abandoned) {
      return;
    }
    inFlight.abandoned = true;
    inFlight.abortController.abort();
  }
}
