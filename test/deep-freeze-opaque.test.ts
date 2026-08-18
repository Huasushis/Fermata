import { describe, expect, it } from "vitest";
import { deepFreeze } from "../src/review-flow/evidence";

describe("deepFreeze 对平台 host 对象的 opaque 处理", () => {
  it("深冻结含 AbortSignal 的 config 后，abort 仍可触发且同一 signal 被传输层观察到", () => {
    const controller = new AbortController();
    const observedAbort: AbortSignal[] = [];
    controller.signal.addEventListener("abort", () => {
      observedAbort.push(controller.signal);
    }, { once: true });

    // 模拟生产 bundle 的快照方式：把 runtime 展开后整体 deepFreeze
    // （与 llm-roles.captureModelConfigs 的 `runtime: { ...model.runtime }` 一致）。
    const bundle = deepFreeze({
      runtime: { ...{ signal: controller.signal } }
    });
    const frozenSignal = (bundle.runtime as { signal: AbortSignal }).signal;

    expect(Object.isFrozen(frozenSignal)).toBe(false);
    expect(() => controller.abort()).not.toThrow();
    expect(controller.signal.aborted).toBe(true);
    // 传输层（fetch/undici signal）观察到的是同一个被冻结 bundle 里的 signal，
    // abort 事件必须正常送达，不能因深冻结而丢失。
    expect(observedAbort).toContain(frozenSignal);
    // opaque：不递归冻结 host 对象内部的属性。
  });

  it("普通 plain config 仍整体深冻结，不放松 immutability", () => {
    const config = deepFreeze({
      nested: { plain: true },
      list: [{ value: 1 }]
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.nested)).toBe(true);
    expect(Object.isFrozen(config.list)).toBe(true);
    expect(Object.isFrozen(config.list[0])).toBe(true);
  });
});
