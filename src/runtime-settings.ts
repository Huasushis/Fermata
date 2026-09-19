import { getProviderCredentials, modelSpecSchema, type AppConfig, type ModelSpec } from "./config";
import type { FermataPublicSettings } from "./urmotiv-schemas";
import type { RuntimeSecrets } from "./settings-secrets";
import type { ProviderCredentialsLike } from "./llm";

export function resolveRuntimeModel(config: AppConfig, settings: FermataPublicSettings, secrets: RuntimeSecrets = {}):
  { spec: ModelSpec; credentials: ProviderCredentialsLike } | undefined {
  const profile = config.models.profiles[settings.modelProfileName];
  if (!profile) return undefined;
  const original = profile.reviewFlow.adjudicator;
  const fallback = getProviderCredentials(config, original.provider);
  const apiKey = secrets.modelApiKey === undefined ? fallback?.apiKey : secrets.modelApiKey;
  const baseUrl = settings.model?.baseUrl ?? fallback?.baseUrl;
  if (!apiKey || !baseUrl) return undefined;
  const model = settings.model;
  const deepseek = model?.model === "deepseek-v4-flash" || model?.model === "deepseek-v4-pro";
  const spec = model === undefined ? original : modelSpecSchema.parse({
    provider: "aether",
    model: model.model,
    temperature: model.temperature,
    thinking: deepseek || model.thinking,
    ...(deepseek ? { thinkingRequest: "enabled", reasoningEffort: "max" } : {})
  });
  return { spec: { ...spec }, credentials: { baseUrl, apiKey } };
}

export function resolveRuntimeRobot(config: AppConfig, settings: FermataPublicSettings, secrets: RuntimeSecrets = {}) {
  const robotToken = secrets.robotToken === undefined ? config.urmotiv.robotToken : secrets.robotToken;
  return robotToken ? { baseUrl: settings.urmotivBaseUrl ?? config.urmotiv.baseUrl, robotToken } : undefined;
}

export function runtimeSettingsDefaults(config: AppConfig, settings: FermataPublicSettings): FermataPublicSettings {
  const model = resolveRuntimeModel(config, settings);
  return {
    ...settings,
    urmotivBaseUrl: settings.urmotivBaseUrl ?? config.urmotiv.baseUrl,
    ...(model === undefined ? {} : { model: {
      baseUrl: model.credentials.baseUrl,
      model: model.spec.model,
      temperature: model.spec.temperature,
      thinking: model.spec.thinking
    } })
  };
}
