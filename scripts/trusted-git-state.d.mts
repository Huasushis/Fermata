export function assertSafeCallerGitEnvironment(
  environment: NodeJS.ProcessEnv
): void;

export interface TrustedGitSnapshot {
  readonly headCodeVersion: string;
  run(
    commandArguments: readonly string[],
    options: { readonly encoding: "utf8" }
  ): string;
  run(
    commandArguments: readonly string[],
    options?: { readonly encoding?: undefined }
  ): Buffer;
}

export function withTrustedGitSnapshot<Result>(
  repositoryDirectory: string,
  callback: (snapshot: TrustedGitSnapshot) => Result
): Result;

export function runTrustedGit(
  repositoryDirectory: string,
  commandArguments: readonly string[],
  options: { readonly encoding: "utf8" }
): string;

export function runTrustedGit(
  repositoryDirectory: string,
  commandArguments: readonly string[],
  options?: { readonly encoding?: undefined }
): Buffer;
