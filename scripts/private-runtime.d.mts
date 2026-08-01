export interface PrivateRuntimeReadOptions {
  readonly privateRoot?: string;
  readonly containingWorkspace?: string;
  readonly maximumBytes?: number;
}

export interface PrivateDirectoryHandle {
  readonly path: string;
  readonly descriptor: number;
  readonly created: boolean;
}

export const projectPrivateRoot: string;
export const workspaceRoot: string;

export function preparePrivateDirectory(
  privateDirectory: string,
  options?: {
    readonly privateRoot?: string;
    readonly containingWorkspace?: string;
  }
): PrivateDirectoryHandle;

export function anchoredPrivatePath(
  privateDirectoryHandle: PrivateDirectoryHandle,
  fileName: string
): string;

export function closePrivateDirectory(
  privateDirectoryHandle: PrivateDirectoryHandle
): void;

export function readProtectedEnvFile(
  envFile: string,
  options?: PrivateRuntimeReadOptions
): string;
