/**
 * review-flow 准确性实验的窄配置入口。
 *
 * 这个模块刻意不调用生产进程的 loadConfig：离线实验不需要 Urmotiv 机器人、
 * 管理端或 Codeforces 凭据，也不应让这些密钥进入实验进程的配置对象。这里只
 * 读取 models.yaml，选出一个档位中的 11 个 reviewFlow 角色，并为这些角色实际
 * 使用的 provider 读取 baseUrl/apiKey。
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  ConfigError,
  modelsYamlSchema,
  reviewFlowModelRoleNames,
  type ProviderCredentials,
  type ProviderName,
  type ReviewFlowModelConfig
} from "../../src/config";
import { parseYamlLite } from "../../src/yaml-lite";

const defaultModelsYamlPath = new URL("../../config/models.yaml", import.meta.url);

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        url.search.length === 0 &&
        url.hash.length === 0
      );
    } catch {
      return false;
    }
  }, "必须是不含账号、密码、查询参数或片段的 http/https 地址");

const providerEnvironmentNames = {
  aether: {
    baseUrl: "AETHER_BASE_URL",
    apiKey: "AETHER_API_KEY"
  },
  dashscope: {
    baseUrl: "DASHSCOPE_BASE_URL",
    apiKey: "DASHSCOPE_API_KEY"
  }
} as const satisfies Record<
  ProviderName,
  { readonly baseUrl: string; readonly apiKey: string }
>;

const permittedProtectedEnvironmentKeys = new Set([
  "AETHER_API_KEY",
  "AETHER_BASE_URL",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "EVAL_CODE_VERSION",
  "EVAL_CONCURRENCY",
  // 这是受控启动方式的约定标记，不是安全证明；调用方仍必须自行执行环境检查。
  "FERMATA_RUN_WITH_ENV",
  // 仅由纯 Node bootstrap 在完成代码/运行时快照后注入；env 文件与父环境不可设置。
  "FERMATA_REVIEW_FLOW_RUNTIME_ATTESTATION"
]);

const forbiddenProjectEnvironmentPrefixes = [
  "CODEFORCES_",
  "URMOTIV_"
] as const;

const protectedEnvironmentPrefixes = [
  "AETHER_",
  "CODEFORCES_",
  "DASHSCOPE_",
  "EVAL_",
  "FERMATA_",
  "URMOTIV_"
] as const;

export interface ReviewFlowEvaluationConfig {
  readonly profileName: string;
  readonly profile: {
    readonly reviewFlow: ReviewFlowModelConfig;
  };
  readonly providers: Partial<
    Readonly<Record<ProviderName, ProviderCredentials>>
  >;
  readonly models: {
    readonly experimentVersion: string;
    readonly retry: {
      readonly maxAttempts: number;
      readonly baseDelayMs: number;
    };
    readonly timeouts: {
      readonly llmFirstOutputMs: number;
      readonly llmOutputIdleMs: number;
      readonly llmMaximumDurationMs: number;
    };
    readonly thresholds: {
      readonly duplicateSimilarityReject: number;
    };
  };
}

export interface LoadReviewFlowEvaluationConfigOptions {
  /** 默认只按固定名称读取当前进程环境；不会展开或复制整个 process.env。 */
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** 测试可注入；正式运行固定读取仓库 config/models.yaml。 */
  readonly modelsYamlSource?: string;
  /** 留空时使用 models.yaml 的 defaults.modelProfileName。 */
  readonly profileName?: string;
}

export function loadReviewFlowEvaluationConfig(
  options: LoadReviewFlowEvaluationConfigOptions = {}
): ReviewFlowEvaluationConfig {
  const environment = options.env ?? process.env;
  assertNarrowReviewFlowEvaluationEnvironment(environment);

  const yamlSource =
    options.modelsYamlSource ?? readFileSync(defaultModelsYamlPath, "utf8");
  let rawModels: unknown;
  try {
    rawModels = parseYamlLite(yamlSource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`config/models.yaml 解析失败：${message}`);
  }
  const modelsResult = modelsYamlSchema.safeParse(rawModels);
  if (!modelsResult.success) {
    throw new ConfigError(
      `config/models.yaml 校验失败：\n${formatZodError(modelsResult.error)}`
    );
  }
  const parsed = modelsResult.data;
  const profileName = options.profileName ?? parsed.defaults.modelProfileName;
  const profile = parsed.profiles[profileName];
  if (profile === undefined) {
    throw new ConfigError("review-flow 实验指定的模型档位不存在。");
  }

  const usedProviders = new Set<ProviderName>(
    reviewFlowModelRoleNames.map((role) => profile.reviewFlow[role].provider)
  );
  const providers: Partial<Record<ProviderName, ProviderCredentials>> = {};
  for (const provider of usedProviders) {
    providers[provider] = readRequiredProviderCredentials(
      environment,
      provider
    );
  }

  return Object.freeze({
    profileName,
    profile: Object.freeze({ reviewFlow: profile.reviewFlow }),
    providers: Object.freeze(providers),
    models: Object.freeze({
      experimentVersion: parsed.experimentVersion,
      retry: Object.freeze({ ...parsed.retry }),
      timeouts: Object.freeze({
        llmFirstOutputMs: parsed.timeouts.llmFirstOutputMs,
        llmOutputIdleMs: parsed.timeouts.llmOutputIdleMs,
        llmMaximumDurationMs: parsed.timeouts.llmMaximumDurationMs
      }),
      thresholds: Object.freeze({ ...parsed.thresholds })
    })
  });
}

export function getReviewFlowEvaluationProviderCredentials(
  config: ReviewFlowEvaluationConfig,
  provider: ProviderName
): ProviderCredentials | undefined {
  return config.providers[provider];
}

/**
 * 防止直接调用或错误包装方式把与评估无关的项目密钥交给当前进程。
 * 错误只返回固定分类，不包含键值。
 */
export function assertNarrowReviewFlowEvaluationEnvironment(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>
): void {
  for (const key of Object.keys(environment)) {
    if (
      forbiddenProjectEnvironmentPrefixes.some((prefix) =>
        key.startsWith(prefix)
      )
    ) {
      throw new ConfigError("review-flow 实验环境包含无关项目凭据。");
    }
    if (
      protectedEnvironmentPrefixes.some((prefix) => key.startsWith(prefix)) &&
      !permittedProtectedEnvironmentKeys.has(key)
    ) {
      throw new ConfigError("review-flow 实验环境包含未登记的受保护变量。");
    }
  }
}

function readRequiredProviderCredentials(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  provider: ProviderName
): ProviderCredentials {
  const names = providerEnvironmentNames[provider];
  const parsed = z
    .object({
      baseUrl: httpUrlSchema,
      apiKey: z.string().trim().min(1).max(4_096)
    })
    .strict()
    .safeParse({
      baseUrl: environment[names.baseUrl],
      apiKey: environment[names.apiKey]
    });
  if (!parsed.success) {
    throw new ConfigError(
      `review-flow 实验缺少或错误配置 ${provider} 的服务地址/密钥。`
    );
  }
  return Object.freeze(parsed.data);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}
