/**
 * 主循环：定时轮询 claim -> 对每个任务并发跑三条难度流水线 -> 跑 verdict 流水线
 * 综合成一份 review -> complete；每个任务独立续租；单个任务失败不影响其它任务和
 * 下一轮轮询；wake() 可以跳过当前等待立即触发一轮轮询；stop() 优雅停机。
 *
 * "现在生效的设置"（enabled/pollingIntervalSeconds/maximumConcurrentTasks/
 * modelProfileName/experimentVersion）都从 SettingsStore 实时读取，不在构造时
 * 固定下来——这样通过管理端口改了设置之后，下一轮轮询（或者调用 wake() 之后）
 * 马上生效，不需要重启进程。
 *
 * 难度/思维/代码三条流水线互相没有数据依赖（都只需要题面+题解本身），所以并发
 * 跑；verdict 流水线需要三者的结果，放在它们都完成之后单独跑。
 */
import {
  getProviderCredentials,
  missingProvidersForProfile,
  type AppConfig,
  type ModelSpec,
  type ProfileConfig
} from "./config";
import type { FetchLike } from "./llm";
import { logError, logInfo, logWarn } from "./logger";
import { runCodingPipeline } from "./pipelines/coding";
import { runDifficultyPipeline, type DifficultyAnchor } from "./pipelines/difficulty";
import type { PipelineModelConfig } from "./pipelines/types";
import { runThinkingPipeline } from "./pipelines/thinking";
import { runVerdictPipeline } from "./pipelines/verdict";
import type { SettingsStoreLike } from "./settings-store";
import { isAuthenticationError, isForbiddenError, isTaskConflictError, UrmotivApiError, type UrmotivClientLike } from "./urmotiv-client";
import type { ClaimRobotReviewTasksResponse, RobotReviewTask } from "./urmotiv-schemas";

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
  /** 停机时最多等待正在处理的任务多久（毫秒），默认 30 秒。 */
  readonly shutdownTimeoutMs?: number;
}

interface InFlightTask {
  readonly assignmentId: string;
  leaseExpiresAt: string;
  renewalTimer: NodeJS.Timeout | null;
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
  readonly #shutdownTimeoutMs: number;

  #running = false;
  #stopping = false;
  #pollTimer: NodeJS.Timeout | null = null;
  readonly #inFlight = new Map<string, InFlightTask>();
  readonly #taskPromises = new Map<string, Promise<void>>();

  public constructor(options: ReviewerWorkerOptions) {
    this.#urmotivClient = options.urmotivClient;
    this.#settingsStore = options.settingsStore;
    this.#appConfig = options.appConfig;
    this.#anchors = options.anchors;
    this.#leaseSeconds = options.leaseSeconds ?? 300;
    this.#fetch = options.fetch;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
  }

  public start(): void {
    if (this.#running) {
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
    const pending = [...this.#taskPromises.values()];
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => setTimeout(resolve, this.#shutdownTimeoutMs))
      ]);
    }
    // 不管任务是自己跑完了，还是等到超时放弃等待了，都把还没清理的续租定时器清掉，
    // 避免残留定时器（测试场景下尤其重要，vitest 不会因为业务逻辑结束就退出进程）。
    for (const inFlight of this.#inFlight.values()) {
      this.clearRenewal(inFlight);
    }
  }

  /** 跳过当前的等待，立即触发一轮轮询；如果已经停机则什么都不做。 */
  public wake(): void {
    if (!this.#running || this.#stopping) {
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
      this.pollOnce()
        .catch((error: unknown) => {
          logError("轮询过程出现未捕获异常", error);
        })
        .finally(() => {
          if (this.#running && !this.#stopping) {
            const { pollingIntervalSeconds } = this.#settingsStore.get().settings;
            this.schedulePoll(pollingIntervalSeconds * 1_000);
          }
        });
    }, delayMs);
  }

  private async pollOnce(): Promise<void> {
    const { settings } = this.#settingsStore.get();
    if (!settings.enabled) {
      return;
    }

    const availableSlots = settings.maximumConcurrentTasks - this.#inFlight.size;
    if (availableSlots <= 0) {
      return;
    }

    const profiles: Record<string, ProfileConfig | undefined> = this.#appConfig.models.profiles;
    const profile = profiles[settings.modelProfileName];
    if (profile === undefined) {
      logWarn("当前设置的 modelProfileName 在 config/models.yaml 里不存在，跳过这一轮轮询", {
        modelProfileName: settings.modelProfileName
      });
      return;
    }
    const missing = missingProvidersForProfile(this.#appConfig, profile);
    if (missing.length > 0) {
      logWarn("当前模型档位缺少 provider 密钥，跳过这一轮轮询", { missing: missing.join(",") });
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

    for (const task of claimed.items) {
      const promise = this.processTask(task, settings.modelProfileName, settings.experimentVersion, profile).finally(
        () => {
          this.#taskPromises.delete(task.assignmentId);
        }
      );
      this.#taskPromises.set(task.assignmentId, promise);
    }
  }

  private async processTask(
    task: RobotReviewTask,
    modelProfileName: string,
    experimentVersion: string,
    profile: ProfileConfig
  ): Promise<void> {
    const inFlight: InFlightTask = {
      assignmentId: task.assignmentId,
      leaseExpiresAt: task.leaseExpiresAt,
      renewalTimer: null,
      abandoned: false
    };
    this.#inFlight.set(task.assignmentId, inFlight);
    this.scheduleRenewal(inFlight);

    try {
      logInfo("开始处理审题任务", { problemId: task.problem.id, revision: task.problem.revision });

      const [difficulty, thinking, coding] = await Promise.all([
        runDifficultyPipeline({
          problem: task.problem,
          anchors: this.#anchors,
          model: this.resolveModelConfig(profile.difficulty)
        }),
        runThinkingPipeline({
          problem: task.problem,
          solverModel: this.resolveModelConfig(profile.thinking.solver),
          analystModel: this.resolveModelConfig(profile.thinking.analyst)
        }),
        runCodingPipeline({
          problem: task.problem,
          model: this.resolveModelConfig(profile.coding)
        })
      ]);

      if (inFlight.abandoned) {
        logWarn("三条难度流水线跑完时任务已经被判定放弃，不再提交", { problemId: task.problem.id });
        return;
      }

      const { review, forcedDuplicateReject } = await runVerdictPipeline({
        problem: task.problem,
        reviewItems: task.reviewItems,
        difficulty,
        thinking,
        coding,
        expectedRound: task.problem.reviewRound,
        model: this.resolveModelConfig(profile.verdict)
      });

      if (inFlight.abandoned) {
        logWarn("综合流水线跑完时任务已经被判定放弃，不再提交", { problemId: task.problem.id });
        return;
      }

      const completion = await this.#urmotivClient.complete(task.assignmentId, {
        expectedLeaseExpiresAt: inFlight.leaseExpiresAt,
        expectedProblemRevision: task.problem.revision,
        experimentVersion,
        modelProfileName,
        review
      });

      logInfo("完成审题任务", {
        problemId: task.problem.id,
        problemStatus: completion.problemStatus,
        forcedDuplicateReject
      });
    } catch (error) {
      this.logTaskFailure(task, error);
    } finally {
      this.clearRenewal(inFlight);
      this.#inFlight.delete(task.assignmentId);
    }
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
    logError("处理审题任务失败", error, { problemId: task.problem.id });
  }

  private resolveModelConfig(spec: ModelSpec): PipelineModelConfig {
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
        timeoutMs: this.#appConfig.models.timeouts.llmRequestMs,
        maxAttempts: this.#appConfig.models.retry.maxAttempts,
        baseDelayMs: this.#appConfig.models.retry.baseDelayMs,
        fetch: this.#fetch
      }
    };
  }

  private scheduleRenewal(inFlight: InFlightTask): void {
    // 租期过半左右续一次，且不少于 5 秒，避免 leaseSeconds 很小时续租过于频繁。
    const renewIntervalMs = Math.max(5_000, this.#leaseSeconds * 500);
    inFlight.renewalTimer = setTimeout(() => {
      this.renewTask(inFlight).catch((error: unknown) => {
        logError("续租时出现未捕获异常", error, { assignmentId: inFlight.assignmentId });
      });
    }, renewIntervalMs);
  }

  private async renewTask(inFlight: InFlightTask): Promise<void> {
    if (inFlight.abandoned || !this.#inFlight.has(inFlight.assignmentId)) {
      return;
    }
    try {
      const result = await this.#urmotivClient.renew(inFlight.assignmentId, {
        expectedLeaseExpiresAt: inFlight.leaseExpiresAt,
        leaseSeconds: this.#leaseSeconds
      });
      inFlight.leaseExpiresAt = result.leaseExpiresAt;
      // processTask 可能在这次 await 期间已经完成并把任务从 #inFlight 里删掉了
      // （它自己的 finally 会调用 clearRenewal，但没法取消一个已经在飞行中的
      // renew() 请求）。这里必须重新检查一遍 #inFlight，否则会为一个已经结束的
      // 任务继续挂一个新的续租定时器，永远续下去。
      if (!inFlight.abandoned && this.#inFlight.has(inFlight.assignmentId)) {
        this.scheduleRenewal(inFlight);
      }
    } catch (error) {
      if (isTaskConflictError(error)) {
        logWarn("续租失败：任务已经不属于我们，标记放弃", { assignmentId: inFlight.assignmentId });
        inFlight.abandoned = true;
        return;
      }
      logError("续租失败，按原计划下次再试", error, { assignmentId: inFlight.assignmentId });
      if (!inFlight.abandoned && this.#inFlight.has(inFlight.assignmentId)) {
        this.scheduleRenewal(inFlight);
      }
    }
  }

  private clearRenewal(inFlight: InFlightTask): void {
    if (inFlight.renewalTimer !== null) {
      clearTimeout(inFlight.renewalTimer);
      inFlight.renewalTimer = null;
    }
  }
}
