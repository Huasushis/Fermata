export const trustedGitExecutable: "/usr/bin/git";

export function buildTrustedGitEnvironment(): NodeJS.ProcessEnv;

export function assertSafeCallerGitEnvironment(
  environment: NodeJS.ProcessEnv
): void;

export interface TrustedGitSnapshot {
  readonly headCodeVersion: string;
  /**
   * status 使用由 HEAD/staged tree 重建且不含正式 stat cache 的临时 index；
   * ls-files 身份查询读取同一受控目录内的正式 index 只读字节副本。
   */
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
