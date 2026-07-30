/**
 * 运行期公开设置：内存 + 文件持久化（settings.json），乐观锁（revision）。
 *
 * 这里对应的是 fermataPublicSettingsSchema/fermataPublicSettingsResponseSchema/
 * updateFermataPublicSettingsInputSchema（见 src/urmotiv-schemas.ts）——
 * plugins/fermata-control 通过管理端口读写的就是这份数据。
 *
 * 并发安全：get()/update() 全程都是同步文件 I/O，没有中间 await。Node 单线程
 * 加上同步函数"运行到完成"的语义，意味着两次几乎同时发起的 update() 调用不会
 * 交错执行——后到的那次一定是在前一次的 revision 检查 + 写盘都完成之后才开始，
 * 天然满足乐观锁需要的原子性，不需要额外加锁。
 *
 * 文件损坏处理：如果 settings.json 存在但内容解析/校验失败，直接抛错而不是
 * 默默地退回默认值——因为默认值里 enabled 可能是 true，静默恢复有可能在
 * 操作员没意识到的情况下重新打开机器人开关，这是安全相关的设置，宁可启动
 * 失败也不要默默改变已保存的状态。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { fermataPublicSettingsSchema, type FermataPublicSettings } from "./urmotiv-schemas";

export class SettingsConflictError extends Error {
  public readonly expectedRevision: number;
  public readonly actualRevision: number;

  public constructor(expectedRevision: number, actualRevision: number) {
    super(`修订号不匹配：期望 ${expectedRevision}，当前实际是 ${actualRevision}。请重新读取设置后再提交。`);
    this.name = "SettingsConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class SettingsFileCorruptedError extends Error {
  public constructor(filePath: string, cause: unknown) {
    super(
      `${filePath} 已存在但无法解析为合法的设置文件，为了避免默默改变已保存的运行状态（比如 enabled），` +
        `拒绝启动。请检查该文件内容，必要时手动修复或删除后重启：${describeCause(cause)}`
    );
    this.name = "SettingsFileCorruptedError";
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface SettingsSnapshot {
  readonly settings: FermataPublicSettings;
  readonly revision: number;
}

/**
 * 只声明 get()/update() 这两个方法，而不是直接依赖 SettingsStore 这个具体类。
 * SettingsStore 结构上自然满足这个接口；server.ts 和 reviewer.ts 都依赖这个
 * 接口而不是具体类，测试时可以传一个不碰文件系统的假实现。
 */
export interface SettingsStoreLike {
  get(): SettingsSnapshot;
  update(expectedRevision: number, settings: FermataPublicSettings): SettingsSnapshot;
}

export interface SettingsStoreOptions {
  readonly filePath: string;
  readonly defaultSettings: FermataPublicSettings;
}

const storedSettingsFileSchema = z
  .object({
    revision: z.number().int().positive(),
    settings: fermataPublicSettingsSchema
  })
  .strict();

export class SettingsStore implements SettingsStoreLike {
  readonly #filePath: string;
  #revision: number;
  #settings: FermataPublicSettings;

  public constructor(options: SettingsStoreOptions) {
    this.#filePath = options.filePath;
    const loaded = this.loadFromDisk();
    if (loaded === null) {
      this.#revision = 1;
      this.#settings = fermataPublicSettingsSchema.parse(options.defaultSettings);
      this.persist();
    } else {
      this.#revision = loaded.revision;
      this.#settings = loaded.settings;
    }
  }

  public get(): SettingsSnapshot {
    return { settings: this.#settings, revision: this.#revision };
  }

  /** expectedRevision 和当前 revision 不一致时抛出 SettingsConflictError，不做任何修改。 */
  public update(expectedRevision: number, settings: FermataPublicSettings): SettingsSnapshot {
    if (expectedRevision !== this.#revision) {
      throw new SettingsConflictError(expectedRevision, this.#revision);
    }
    this.#settings = fermataPublicSettingsSchema.parse(settings);
    this.#revision += 1;
    this.persist();
    return this.get();
  }

  private loadFromDisk(): { revision: number; settings: FermataPublicSettings } | null {
    if (!existsSync(this.#filePath)) {
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#filePath, "utf8"));
    } catch (error) {
      throw new SettingsFileCorruptedError(this.#filePath, error);
    }
    const parsed = storedSettingsFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SettingsFileCorruptedError(this.#filePath, parsed.error);
    }
    return parsed.data;
  }

  private persist(): void {
    const dir = dirname(this.#filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const payload = JSON.stringify({ revision: this.#revision, settings: this.#settings }, null, 2);
    const tmpPath = `${this.#filePath}.tmp-${process.pid}`;
    // 先写临时文件再原子改名，避免进程在写盘过程中被杀掉时留下半截的 JSON。
    writeFileSync(tmpPath, payload, "utf8");
    renameSync(tmpPath, this.#filePath);
  }
}
