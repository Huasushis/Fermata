export function assertSafeNodeEnvironment(
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>
): void;

export function assertNoUnknownPrefixedEnvironmentKeys(
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  allowedKeys: readonly string[],
  protectedPrefixes: readonly string[]
): void;

export function parseEnvFile(content: string): Record<string, string>;

export function selectEnvironment(
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  allowedKeys: readonly string[]
): Record<string, string>;
