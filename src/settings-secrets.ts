import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { FermataSecretUpdate } from "./urmotiv-schemas";

const secretsSchema = z.object({
  modelApiKey: z.string().max(4_096).nullable().optional(),
  robotToken: z.string().max(4_096).nullable().optional()
}).strict();
export type RuntimeSecrets = z.infer<typeof secretsSchema>;

export function updateRuntimeSecrets(current: RuntimeSecrets, input: FermataSecretUpdate): RuntimeSecrets {
  return {
    ...current,
    ...(input.clearModelApiKey ? { modelApiKey: null } : input.modelApiKey ? { modelApiKey: input.modelApiKey } : {}),
    ...(input.clearRobotToken ? { robotToken: null } : input.robotToken ? { robotToken: input.robotToken } : {})
  };
}

function readKey(path: string, create: boolean): Buffer {
  if (create && !existsSync(path)) writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error("设置密钥长度无效。");
  return key;
}

export function sealSettingsSecrets(secrets: RuntimeSecrets, keyPath: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", readKey(keyPath, true), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(":");
}

export function openSettingsSecrets(value: string, keyPath: string): RuntimeSecrets {
  try {
    const [version, iv, tag, payload, extra] = value.split(":");
    if (version !== "v1" || !iv || !tag || !payload || extra !== undefined) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", readKey(keyPath, false), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(payload, "base64")), decipher.final()]);
    return secretsSchema.parse(JSON.parse(plain.toString("utf8")));
  } catch {
    throw new Error("已保存的运行密钥无法解密；请恢复与设置文件配套的密钥文件。");
  }
}
