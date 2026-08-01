/**
 * 入口：读取配置、装配 SettingsStore/UrmotivClient/ReviewerWorker/管理端口，
 * 启动，注册信号处理，实现优雅停机。
 */
import { ConfigError, loadConfig, missingProvidersForProfile, type ProfileConfig } from "./config";
import { logError, logInfo, logWarn } from "./logger";
import { loadDifficultyAnchors } from "./pipelines/difficulty";
import { ReviewerWorker } from "./reviewer";
import { createDefaultReviewerSettings } from "./reviewer-activation";
import { createProductionEligibilityVerifier } from "./production-eligibility";
import { createManagementServer } from "./server";
import { SettingsStore } from "./settings-store";
import { UrmotivClient } from "./urmotiv-client";

function main(): void {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) {
      logError("启动配置校验失败，进程退出", error);
    } else {
      logError("启动过程出现意料之外的错误，进程退出", error);
    }
    process.exit(1);
  }
}

function run(): void {
  const config = loadConfig();

  const anchors = loadDifficultyAnchors();
  if (anchors.length === 0) {
    logWarn(
      "难度锚点为空（config/anchors/difficulty.json 缺失或格式不对），CF 难度评估会缺少参照，" +
        "建议检查该文件，或运行 npm run experiment:calibrate-anchors 重新生成"
    );
  } else {
    logInfo("已加载难度锚点", { count: anchors.length });
  }

  const settingsStore = new SettingsStore({
    filePath: config.server.settingsPath,
    defaultSettings: createDefaultReviewerSettings(config.models)
  });

  const urmotivClient = new UrmotivClient({
    baseUrl: config.urmotiv.baseUrl,
    robotToken: config.urmotiv.robotToken
  });

  const productionEligibility = createProductionEligibilityVerifier(config);

  const reviewer = new ReviewerWorker({
    urmotivClient,
    settingsStore,
    appConfig: config,
    anchors,
    productionEligibility: (profileName) => productionEligibility.verify(profileName)
  });

  const secretsConfigured = (): boolean => {
    const { settings } = settingsStore.get();
    const profiles: Record<string, ProfileConfig | undefined> = config.models.profiles;
    const profile = profiles[settings.modelProfileName];
    return profile !== undefined && missingProvidersForProfile(config, profile).length === 0;
  };

  const server = createManagementServer({
    managementToken: config.server.managementToken,
    settingsStore,
    secretsConfigured,
    getWorkerStatus: () => reviewer.getStatus(),
    wake: () => {
      reviewer.wake();
    }
  });

  // 兜底日志：正常情况下每个任务、每次轮询的错误都应该已经在各自的 try/catch
  // 里被捕获、分类、记录了；这里只是防止漏网的异常直接让进程崩掉——记录下来，
  // 不主动退出（单个意料之外的异常不应该让整个服务停摆，这和"单任务失败不
  // 影响其它任务"是同一个原则的延伸）。
  process.on("unhandledRejection", (reason) => {
    logError("出现没有被捕获的 Promise rejection", reason);
  });
  process.on("uncaughtException", (error) => {
    logError("出现没有被捕获的异常", error);
  });

  reviewer.start();
  server.listen(config.server.port, () => {
    logInfo("Fermata 启动完成", { port: config.server.port, secretsConfigured: secretsConfigured() });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logInfo("收到停机信号，开始优雅停机", { signal });
    server.close();
    reviewer
      .stop()
      .then(() => {
        logInfo("停机完成");
        process.exit(0);
      })
      .catch((error: unknown) => {
        logError("停机过程中出现异常，强制退出", error);
        process.exit(1);
      });
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}

main();
