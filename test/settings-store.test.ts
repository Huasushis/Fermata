import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsConflictError, SettingsFileCorruptedError, SettingsStore } from "../src/settings-store";
import type { FermataPublicSettings } from "../src/urmotiv-schemas";

const defaultSettings: FermataPublicSettings = {
  enabled: true,
  pollingIntervalSeconds: 30,
  maximumConcurrentTasks: 2,
  modelProfileName: "review-balanced",
  experimentVersion: "experiment-2026-07"
};

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fermata-settings-test-"));
  filePath = join(dir, "settings.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SettingsStore：初始化", () => {
  it("文件不存在时用默认设置初始化，并把它写入文件", () => {
    const store = new SettingsStore({ filePath, defaultSettings });
    expect(store.get()).toEqual({ settings: defaultSettings, revision: 1 });
    expect(existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    expect(onDisk).toEqual({ revision: 1, settings: defaultSettings });
  });

  it("文件已存在且合法时从文件恢复，不使用传入的默认设置", () => {
    const first = new SettingsStore({ filePath, defaultSettings });
    const changed: FermataPublicSettings = { ...defaultSettings, enabled: false, pollingIntervalSeconds: 60 };
    first.update(1, changed);

    // 模拟进程重启：用同一个文件路径重新构造一个 SettingsStore。
    const second = new SettingsStore({ filePath, defaultSettings });
    expect(second.get()).toEqual({ settings: changed, revision: 2 });
  });

  it("已有旧 experimentVersion 保持原值，不会被新部署的默认值自动改写", () => {
    const oldSettings = { ...defaultSettings, enabled: true, experimentVersion: "experiment-old" };
    writeFileSync(filePath, JSON.stringify({ revision: 7, settings: oldSettings }), "utf8");

    const store = new SettingsStore({
      filePath,
      defaultSettings: { ...defaultSettings, enabled: false, experimentVersion: "experiment-current" }
    });

    expect(store.get()).toEqual({ settings: oldSettings, revision: 7 });
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ revision: 7, settings: oldSettings });
  });

  it("文件存在但内容不是合法 JSON 时拒绝启动", () => {
    writeFileSync(filePath, "{ not valid json", "utf8");
    expect(() => new SettingsStore({ filePath, defaultSettings })).toThrow(SettingsFileCorruptedError);
  });

  it("文件存在但不满足 schema 时拒绝启动", () => {
    writeFileSync(filePath, JSON.stringify({ revision: 1, settings: { enabled: "not-a-boolean" } }), "utf8");
    expect(() => new SettingsStore({ filePath, defaultSettings })).toThrow(SettingsFileCorruptedError);
  });

  it("已有设置缺少 experimentVersion 时拒绝启动，不会用当前默认版本补写", () => {
    const { experimentVersion: _missing, ...settingsWithoutVersion } = defaultSettings;
    const original = JSON.stringify({ revision: 3, settings: settingsWithoutVersion });
    writeFileSync(filePath, original, "utf8");

    expect(() => new SettingsStore({ filePath, defaultSettings })).toThrow(SettingsFileCorruptedError);
    expect(readFileSync(filePath, "utf8")).toBe(original);
  });
});

describe("SettingsStore：update 的乐观锁", () => {
  it("expectedRevision 正确时更新成功，revision 自增并持久化到文件", () => {
    const store = new SettingsStore({ filePath, defaultSettings });
    const changed: FermataPublicSettings = { ...defaultSettings, maximumConcurrentTasks: 5 };
    const result = store.update(1, changed);
    expect(result).toEqual({ settings: changed, revision: 2 });
    expect(store.get()).toEqual({ settings: changed, revision: 2 });
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    expect(onDisk).toEqual({ revision: 2, settings: changed });
  });

  it("expectedRevision 不匹配时抛出 SettingsConflictError，且不改变已有状态", () => {
    const store = new SettingsStore({ filePath, defaultSettings });
    const changed: FermataPublicSettings = { ...defaultSettings, maximumConcurrentTasks: 9 };
    expect(() => store.update(999, changed)).toThrow(SettingsConflictError);
    expect(store.get()).toEqual({ settings: defaultSettings, revision: 1 });
  });

  it("一次因 revision 不匹配失败的更新之后，用正确的 revision 重试仍然能成功", () => {
    const store = new SettingsStore({ filePath, defaultSettings });
    const changed: FermataPublicSettings = { ...defaultSettings, maximumConcurrentTasks: 9 };
    expect(() => store.update(999, changed)).toThrow(SettingsConflictError);
    const result = store.update(1, changed);
    expect(result.revision).toBe(2);
    expect(result.settings).toEqual(changed);
  });

  it("update 传入不满足 schema 的设置时抛错，且不改变已有状态", () => {
    const store = new SettingsStore({ filePath, defaultSettings });
    const invalid: FermataPublicSettings = { ...defaultSettings, pollingIntervalSeconds: 100_000 }; // 超出 max 3600
    expect(() => store.update(1, invalid)).toThrow();
    expect(store.get()).toEqual({ settings: defaultSettings, revision: 1 });
  });
});
