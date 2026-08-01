/**
 * 启动配置：合并环境变量（密钥、Urmotiv 连接信息、端口）和
 * config/models.yaml（模型档位、并发、阈值等非密钥配置），校验后产出一个
 * 不可变的 AppConfig。校验失败（必需项缺失或格式不对）会抛出 ConfigError，
 * 让进程在处理任何任务之前就崩溃退出，而不是带着一个残缺的配置继续跑。
 *
 * 密钥（机器人令牌、管理令牌、模型 API Key、CF key/secret）只存在于这个
 * 模块产出的内存对象里，不写文件、不进日志。
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseYamlLite } from "./yaml-lite";

export class ConfigError extends Error {
  public readonly code = "CONFIG_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ---------------------------------------------------------------------------
// 环境变量
// ---------------------------------------------------------------------------

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

const envSchema = z
  .object({
    URMOTIV_BASE_URL: httpUrlSchema,
    URMOTIV_ROBOT_TOKEN: z.string().trim().min(8).max(4_096),
    FERMATA_PORT: z.coerce.number().int().min(1).max(65_535).default(8720),
    // 和 plugins/fermata-control/src/index.ts 里 FermataControlClient 对管理令牌
    // 的校验（min(16).max(4_096)）保持一致，否则两边会互相拒绝对方发来的令牌。
    FERMATA_MANAGEMENT_TOKEN: z.string().trim().min(16).max(4_096),
    FERMATA_SETTINGS_PATH: z.string().trim().min(1).default("./data/settings.json"),
    AETHER_BASE_URL: httpUrlSchema.optional(),
    AETHER_API_KEY: z.string().trim().min(1).max(4_096).optional(),
    DASHSCOPE_BASE_URL: httpUrlSchema.optional(),
    DASHSCOPE_API_KEY: z.string().trim().min(1).max(4_096).optional(),
    CODEFORCES_KEY: z.string().trim().min(1).max(200).optional(),
    CODEFORCES_SECRET: z.string().trim().min(1).max(200).optional()
  })
  .superRefine((env, ctx) => {
    if ((env.AETHER_BASE_URL === undefined) !== (env.AETHER_API_KEY === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AETHER_BASE_URL"],
        message: "AETHER_BASE_URL 和 AETHER_API_KEY 必须同时设置或同时留空。"
      });
    }
    if ((env.DASHSCOPE_BASE_URL === undefined) !== (env.DASHSCOPE_API_KEY === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DASHSCOPE_BASE_URL"],
        message: "DASHSCOPE_BASE_URL 和 DASHSCOPE_API_KEY 必须同时设置或同时留空。"
      });
    }
    if ((env.CODEFORCES_KEY === undefined) !== (env.CODEFORCES_SECRET === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CODEFORCES_KEY"],
        message: "CODEFORCES_KEY 和 CODEFORCES_SECRET 必须同时设置或同时留空。"
      });
    }
  });

type Env = z.infer<typeof envSchema>;

// ---------------------------------------------------------------------------
// config/models.yaml
// ---------------------------------------------------------------------------

export const providerNameSchema = z.enum(["aether", "dashscope"]);
export type ProviderName = z.infer<typeof providerNameSchema>;

export const modelSpecSchema = z
  .object({
    provider: providerNameSchema,
    model: z.string().trim().min(1).max(200),
    temperature: z.number().min(0).max(2),
    thinking: z.boolean()
  })
  .strict();
export type ModelSpec = z.infer<typeof modelSpecSchema>;

export const profileConfigSchema = z
  .object({
    difficulty: modelSpecSchema,
    thinking: z
      .object({
        solver: modelSpecSchema,
        analyst: modelSpecSchema
      })
      .strict(),
    coding: modelSpecSchema,
    verdict: modelSpecSchema
  })
  .strict();
export type ProfileConfig = z.infer<typeof profileConfigSchema>;

export const modelsYamlSchema = z
  .object({
    experimentVersion: z.string().trim().min(1).max(120),
    defaults: z
      .object({
        modelProfileName: z.string().trim().min(1).max(120),
        pollingIntervalSeconds: z.number().int().min(5).max(3_600),
        maximumConcurrentTasks: z.number().int().min(1).max(32)
      })
      .strict(),
    profiles: z.record(z.string(), profileConfigSchema),
    retry: z
      .object({
        maxAttempts: z.number().int().min(1).max(10),
        baseDelayMs: z.number().int().min(1).max(60_000)
      })
      .strict(),
    timeouts: z
      .object({
        llmFirstOutputMs: z.number().int().min(1_800_000).max(86_400_000),
        llmOutputIdleMs: z.number().int().min(600_000).max(86_400_000),
        llmMaximumDurationMs: z.number().int().min(14_400_000).max(86_400_000),
        codeforcesRequestMs: z.number().int().min(1_000).max(600_000)
      })
      .strict()
      .superRefine((timeouts, context) => {
        if (
          timeouts.llmMaximumDurationMs < timeouts.llmFirstOutputMs ||
          timeouts.llmMaximumDurationMs < timeouts.llmOutputIdleMs
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["llmMaximumDurationMs"],
            message: "有效输出前的最终保护时长不能小于首输出或输出停顿的时长。"
          });
        }
      }),
    codeforces: z
      .object({
        minimumRequestIntervalMs: z.number().int().min(0).max(60_000)
      })
      .strict(),
    thresholds: z
      .object({
        duplicateSimilarityReject: z.number().min(0).max(1)
      })
      .strict()
  })
  .strict()
  .superRefine((yaml, ctx) => {
    if (Object.keys(yaml.profiles).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["profiles"], message: "至少需要一个模型档位。" });
      return;
    }
    if (!(yaml.defaults.modelProfileName in yaml.profiles)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaults", "modelProfileName"],
        message: `defaults.modelProfileName "${yaml.defaults.modelProfileName}" 在 profiles 中不存在。`
      });
    }
  });
export type ModelsConfig = z.infer<typeof modelsYamlSchema>;

// ---------------------------------------------------------------------------
// AppConfig
// ---------------------------------------------------------------------------

export interface ProviderCredentials {
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface AppConfig {
  readonly urmotiv: {
    readonly baseUrl: string;
    readonly robotToken: string;
  };
  readonly server: {
    readonly port: number;
    readonly managementToken: string;
    readonly settingsPath: string;
  };
  readonly providers: Partial<Record<ProviderName, ProviderCredentials>>;
  readonly codeforces: { readonly key: string; readonly secret: string } | null;
  readonly models: ModelsConfig;
}

export interface LoadConfigOptions {
  /** 默认读取真实进程环境变量，测试可以注入一个假的对象。 */
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** 默认读取仓库里的 config/models.yaml，测试可以注入任意 YAML 字符串。 */
  readonly modelsYamlSource?: string;
}

const defaultModelsYamlPath = new URL("../config/models.yaml", import.meta.url);

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const rawEnv = options.env ?? process.env;
  const envResult = envSchema.safeParse(rawEnv);
  if (!envResult.success) {
    throw new ConfigError(`环境变量校验失败：\n${formatZodError(envResult.error)}`);
  }
  const env: Env = envResult.data;

  const yamlSource = options.modelsYamlSource ?? readFileSync(defaultModelsYamlPath, "utf8");
  let rawModels: unknown;
  try {
    rawModels = parseYamlLite(yamlSource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`config/models.yaml 解析失败：${message}`);
  }
  const modelsResult = modelsYamlSchema.safeParse(rawModels);
  if (!modelsResult.success) {
    throw new ConfigError(`config/models.yaml 校验失败：\n${formatZodError(modelsResult.error)}`);
  }
  const models = modelsResult.data;

  const providers: Partial<Record<ProviderName, ProviderCredentials>> = {};
  if (env.AETHER_BASE_URL !== undefined && env.AETHER_API_KEY !== undefined) {
    providers.aether = { baseUrl: env.AETHER_BASE_URL, apiKey: env.AETHER_API_KEY };
  }
  if (env.DASHSCOPE_BASE_URL !== undefined && env.DASHSCOPE_API_KEY !== undefined) {
    providers.dashscope = { baseUrl: env.DASHSCOPE_BASE_URL, apiKey: env.DASHSCOPE_API_KEY };
  }

  const codeforces =
    env.CODEFORCES_KEY !== undefined && env.CODEFORCES_SECRET !== undefined
      ? { key: env.CODEFORCES_KEY, secret: env.CODEFORCES_SECRET }
      : null;

  const config: AppConfig = {
    urmotiv: { baseUrl: env.URMOTIV_BASE_URL, robotToken: env.URMOTIV_ROBOT_TOKEN },
    server: {
      port: env.FERMATA_PORT,
      managementToken: env.FERMATA_MANAGEMENT_TOKEN,
      settingsPath: env.FERMATA_SETTINGS_PATH
    },
    providers,
    codeforces,
    models
  };

  // 用 Record<string, ProfileConfig | undefined> 读取，这样即使 modelsYamlSchema
  // 的 superRefine 保证了这个 key 一定存在，TypeScript 也不会把下面的 undefined
  // 检查当成永假表达式报错；同时这行检查本身也是防御性的运行时保险。
  const profiles: Record<string, ProfileConfig | undefined> = models.profiles;
  const defaultProfile = profiles[models.defaults.modelProfileName];
  if (defaultProfile === undefined) {
    throw new ConfigError("内部错误：默认模型档位不存在。");
  }
  const missing = missingProvidersForProfile(config, defaultProfile);
  if (missing.length > 0) {
    throw new ConfigError(
      `默认模型档位 "${models.defaults.modelProfileName}" 需要以下服务商的密钥，但环境变量里没有配置：` +
        `${missing.join("、")}。请检查 .env 中对应的 *_BASE_URL / *_API_KEY，或修改 config/models.yaml 使用已配置的服务商。`
    );
  }

  return config;
}

/** 返回 AppConfig 里已经配置好密钥的服务商对应的凭据，没配置则返回 undefined。 */
export function getProviderCredentials(
  config: AppConfig,
  provider: ProviderName
): ProviderCredentials | undefined {
  return config.providers[provider];
}

/** 一个模型档位里用到的全部 provider（去重）。 */
export function providersUsedByProfile(profile: ProfileConfig): ProviderName[] {
  const providers = new Set<ProviderName>([
    profile.difficulty.provider,
    profile.thinking.solver.provider,
    profile.thinking.analyst.provider,
    profile.coding.provider,
    profile.verdict.provider
  ]);
  return [...providers];
}

/** 一个模型档位里，哪些用到的 provider 还没有配置密钥。 */
export function missingProvidersForProfile(config: AppConfig, profile: ProfileConfig): ProviderName[] {
  return providersUsedByProfile(profile).filter((provider) => getProviderCredentials(config, provider) === undefined);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}
