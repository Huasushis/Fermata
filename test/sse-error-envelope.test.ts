import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  describeRejectedSseEvent,
  type LlmSseRejectedEventAudit
} from "../src/llm";

function sseErrorEvent(errorObject: unknown): string {
  return `data: ${JSON.stringify({ error: errorObject })}\n\n`;
}

describe("SSE error envelope: privacy — unknown keys never persisted verbatim", () => {
  it("persists only allowlist field names and types; unknown key names absent from serialized audit", () => {
    const privateKeyName = "SUPER_SECRET_API_TOKEN_FIELD";
    const privateValue = "sk-leaked-key-12345";
    const event = sseErrorEvent({
      code: "rate_limited",
      message: "Too many requests",
      [privateKeyName]: privateValue,
      another_unknown: { nested: "private_data" }
    });
    const audit = describeRejectedSseEvent(event, 1);
    const serialized = JSON.stringify(audit);

    // Private key name must not appear in serialized audit
    expect(serialized).not.toContain(privateKeyName);
    expect(serialized).not.toContain("another_unknown");
    // Private value must not appear
    expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toContain("private_data");

    // Only allowlist fields should be in allowedFields
    const envelope = audit.errorEnvelope!;
    expect(envelope.present).toBe(true);
    expect(envelope.classification).toBe("unknown_fields_present");
    expect(envelope.unknownFieldCount).toBe(2);
    const allowedKeyNames = envelope.allowedFields.map((f) => f.key);
    expect(allowedKeyNames).toContain("code");
    expect(allowedKeyNames).toContain("message");
    expect(allowedKeyNames).not.toContain(privateKeyName);
  });

  it("classifies known_fields_only when all keys are in the allowlist", () => {
    const event = sseErrorEvent({
      code: "server_error",
      message: "Internal error",
      type: "internal_server_error",
      status: 500
    });
    const audit = describeRejectedSseEvent(event, 1);
    const envelope = audit.errorEnvelope!;
    expect(envelope.classification).toBe("known_fields_only");
    expect(envelope.unknownFieldCount).toBe(0);
    expect(envelope.allowedFields).toHaveLength(4);
  });

  it("classifies non_object when error value is not an object", () => {
    const event = sseErrorEvent("just a string error");
    const audit = describeRejectedSseEvent(event, 1);
    const envelope = audit.errorEnvelope!;
    expect(envelope.classification).toBe("non_object");
    expect(envelope.fieldCount).toBe(0);
    expect(envelope.allowedFields).toEqual([]);
  });

  it("persists unknownKeysFingerprint as a domain-separated irreversible hash", () => {
    const privateKeyName = "LEAKED_CUSTOMER_ID";
    const event1 = sseErrorEvent({ [privateKeyName]: "value1" });
    const event2 = sseErrorEvent({ [privateKeyName]: "value2" });
    const audit1 = describeRejectedSseEvent(event1, 1);
    const audit2 = describeRejectedSseEvent(event2, 1);

    // Same unknown key name → same fingerprint (key name hash is deterministic)
    expect(audit1.errorEnvelope!.unknownKeysFingerprint).toBe(
      audit2.errorEnvelope!.unknownKeysFingerprint
    );
    // Different unknown key name → different fingerprint
    const event3 = sseErrorEvent({ DIFFERENT_KEY: "value3" });
    const audit3 = describeRejectedSseEvent(event3, 1);
    expect(audit3.errorEnvelope!.unknownKeysFingerprint).not.toBe(
      audit1.errorEnvelope!.unknownKeysFingerprint
    );
    // The raw key name must not appear in the fingerprint value itself
    expect(audit1.errorEnvelope!.unknownKeysFingerprint).not.toContain(privateKeyName);
  });

  it("persists allowedNestedObjectKeys only from closed nested allowlist", () => {
    const event = sseErrorEvent({
      error: { nested: "data" },
      detail: { more: "data" },
      code: "fail",
      unknown_nested: { secret: "value" }
    });
    const audit = describeRejectedSseEvent(event, 1);
    const envelope = audit.errorEnvelope!;
    // error and detail are in the nested allowlist
    expect(envelope.allowedNestedObjectKeys).toContain("error");
    expect(envelope.allowedNestedObjectKeys).toContain("detail");
    // unknown_nested is not in the nested allowlist
    expect(envelope.allowedNestedObjectKeys).not.toContain("unknown_nested");
    // Also not in the field allowlist so not in allowedFields
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("unknown_nested");
    expect(serialized).not.toContain("secret");
  });

  it("error events are permanently rejected — shape is error_object", () => {
    const event = sseErrorEvent({ code: "fail", message: "bad" });
    const audit = describeRejectedSseEvent(event, 1);
    expect(audit.shape).toBe("error_object");
  });

  it("sentinel: unknown top-level sibling PRIVATE_FIELD_NAME absent from entire serialized audit while schema accepts safe representation", () => {
    const privateFieldName = "PRIVATE_FIELD_NAME";
    const privateFieldValue = "synthetic-private-value";
    // Content-free sentinel: top-level has error (known) + an unknown sibling
    const event = `data: ${JSON.stringify({
      error: "synthetic",
      [privateFieldName]: privateFieldValue
    })}\n\n`;
    const audit = describeRejectedSseEvent(event, 1);
    const serialized = JSON.stringify(audit);

    // Sentinel field name must not appear anywhere in the serialized audit
    expect(serialized).not.toContain(privateFieldName);
    // Sentinel value must not appear
    expect(serialized).not.toContain(privateFieldValue);

    // Known top-level key "error" is persisted; unknown sibling is count+fingerprint only
    expect(audit.topLevelKeys).toContain("error");
    expect(audit.topLevelKeys).not.toContain(privateFieldName);
    expect(audit.unknownTopLevelKeyCount).toBe(1);
    expect(audit.unknownTopLevelKeysFingerprint).toMatch(/^[a-f0-9]{64}$/u);

    // Structure also sanitized
    expect(audit.structure.unknownTopLevelKeyCount).toBe(1);
    expect(audit.structure.unknownTopLevelKeysFingerprint).toMatch(/^[a-f0-9]{64}$/u);

    // Build a full failure detail matching the new audit shape and verify schema accepts it
    const safeDetail = syntheticNewFailureDetail();
    // Verify schema accepts the safe representation (already has sanitized fields from fixture)
    const result = safeRequestFailureSchema.safeParse(safeDetail);
    expect(result.success).toBe(true);
  });
});

import { safeRequestFailureSchema, safeRequestFailureReadSchema, privateCheckpointReadSchema } from "../experiments/lib/development-smoke-launcher";

function syntheticOldFailureDetail() {
  return {
    kind: "schema_invalid" as const,
    code: "LLM_RESPONSE_FORMAT_INVALID" as const,
    httpStatus: null,
    requestCount: 1,
    transportAttemptCount: 1,
    completedResponseCount: 0,
    terminalResponseMode: "sse" as const,
    terminalEofObserved: true,
    terminalFinishReasonStopObserved: false,
    terminalSseDoneObserved: null,
    jsonSchemaValidated: null,
    streamEventCount: 3,
    streamUtf8Bytes: 256,
    streamChunkCount: 3,
    usageEventCount: 1,
    usageTotalTokens: 7,
    acceptedEventShapes: [
      { category: "metadata" as const, shapeFingerprint: "a".repeat(64), count: 1 },
      { category: "usage" as const, shapeFingerprint: "b".repeat(64), count: 1 }
    ],
    // Old ae47bbc format: no errorEnvelope field in firstRejectedEvent
    firstRejectedEvent: {
      eventOrdinal: 2,
      completedEventCount: 1,
      dataFieldCount: 1,
      eventUtf8Bytes: 128,
      topLevelKeys: ["error"],
      unknownTopLevelKeyCount: 0,
      unknownTopLevelKeysFingerprint: "0".repeat(64),
      choiceKeys: [],
      unknownChoiceKeyCount: 0,
      unknownChoiceKeysFingerprint: "0".repeat(64),
      deltaKeys: [],
      unknownPayloadKeyCount: 0,
      unknownPayloadKeysFingerprint: "0".repeat(64),
      shape: "error_object" as const,
      structure: {
        fieldTypes: {
          choices: "missing",
          created: "missing",
          id: "missing",
          model: "missing",
          object: "missing",
          serviceTier: "missing",
          systemFingerprint: "missing",
          usage: "missing",
          error: "object",
          control: "missing",
          choice: "missing",
          delta: "missing",
          message: "missing",
          finishReason: "missing",
          index: "missing",
          logprobs: "missing",
          deltaFields: {
            content: "missing",
            reasoningContent: "missing",
            reasoning: "missing",
            role: "missing",
            functionCall: "missing",
            refusal: "missing",
            toolCalls: "missing"
          },
          messageFields: {
            content: "missing",
            reasoningContent: "missing",
            reasoning: "missing",
            role: "missing",
            functionCall: "missing",
            refusal: "missing",
            toolCalls: "missing"
          }
        },
        choicesLength: "0",
        payloadSource: "neither",
        finishReasonClass: "missing",
        finishReasonIsNull: false,
        finishReasonUnknownStringHash: null,
        hasUsageField: false,
        hasErrorField: true,
        hasControlField: false,
        unknownTopLevelKeyCount: 0,
        unknownTopLevelKeysFingerprint: "0".repeat(64),
        unknownChoiceKeyCount: 0,
        unknownChoiceKeysFingerprint: "0".repeat(64),
        unknownPayloadKeyCount: 0,
        unknownPayloadKeysFingerprint: "0".repeat(64),
        unknownKeysFingerprint: "0".repeat(64)
      },
      shapeFingerprint: "0000000000000000000000000000000000000000000000000000000000000000"
      // NOTE: no errorEnvelope field — old ae47bbc format
    },
    formatFailureStage: "event_shape" as const,
    formatFailureSubstage: null
  };
}

function syntheticNewFailureDetail() {
  return {
    ...syntheticOldFailureDetail(),
    firstRejectedEvent: {
      ...syntheticOldFailureDetail().firstRejectedEvent!,
      errorEnvelope: {
        present: true as const,
        classification: "known_fields_only" as const,
        fieldCount: 2,
        allowedFields: [
          { key: "code", type: "string" },
          { key: "message", type: "string" }
        ],
        allowedNestedObjectKeys: [],
        unknownFieldCount: 0,
        unknownKeysFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
        envelopeFingerprint: "0000000000000000000000000000000000000000000000000000000000000000"
      }
    }
  };
}

/**
 * Unmodified content-free legacy ae47bbc fixture: raw unknown key arrays,
 * no count/fingerprint fields, no errorEnvelope. This is the exact format
 * written by commit ae47bbc — never migrated or written back.
 */
function syntheticLegacyAe47bbcFailureDetail() {
  return {
    kind: "schema_invalid" as const,
    code: "LLM_RESPONSE_FORMAT_INVALID" as const,
    httpStatus: null,
    requestCount: 1,
    transportAttemptCount: 1,
    completedResponseCount: 0,
    terminalResponseMode: "sse" as const,
    terminalEofObserved: true,
    terminalFinishReasonStopObserved: false,
    terminalSseDoneObserved: null,
    jsonSchemaValidated: null,
    streamEventCount: 3,
    streamUtf8Bytes: 256,
    streamChunkCount: 3,
    usageEventCount: 1,
    usageTotalTokens: 7,
    acceptedEventShapes: [
      { category: "metadata" as const, shapeFingerprint: "a".repeat(64), count: 1 },
      { category: "usage" as const, shapeFingerprint: "b".repeat(64), count: 1 }
    ],
    firstRejectedEvent: {
      eventOrdinal: 2,
      completedEventCount: 1,
      dataFieldCount: 1,
      eventUtf8Bytes: 128,
      topLevelKeys: ["error"],
      choiceKeys: [],
      deltaKeys: [],
      shape: "error_object" as const,
      structure: {
        fieldTypes: {
          choices: "missing",
          created: "missing",
          id: "missing",
          model: "missing",
          object: "missing",
          serviceTier: "missing",
          systemFingerprint: "missing",
          usage: "missing",
          error: "object",
          control: "missing",
          choice: "missing",
          delta: "missing",
          message: "missing",
          finishReason: "missing",
          index: "missing",
          logprobs: "missing",
          deltaFields: {
            content: "missing",
            reasoningContent: "missing",
            reasoning: "missing",
            role: "missing",
            functionCall: "missing",
            refusal: "missing",
            toolCalls: "missing"
          },
          messageFields: {
            content: "missing",
            reasoningContent: "missing",
            reasoning: "missing",
            role: "missing",
            functionCall: "missing",
            refusal: "missing",
            toolCalls: "missing"
          }
        },
        choicesLength: "0",
        payloadSource: "neither",
        finishReasonClass: "missing",
        finishReasonIsNull: false,
        finishReasonUnknownStringHash: null,
        hasUsageField: false,
        hasErrorField: true,
        hasControlField: false,
        unknownTopLevelKeys: [],
        unknownChoiceKeys: [],
        unknownPayloadKeys: [],
        unknownKeysFingerprint: "0000000000000000000000000000000000000000000000000000000000000000"
      },
      shapeFingerprint: "0000000000000000000000000000000000000000000000000000000000000000"
    },
    formatFailureStage: "event_shape" as const,
    formatFailureSubstage: null
  };
}

describe("Backward compatibility: checkpoint parser accepts old and new failure receipts", () => {
  it("parses old ae47bbc failure receipt without errorEnvelope field", () => {
    const oldDetail = syntheticOldFailureDetail();
    const result = safeRequestFailureSchema.safeParse(oldDetail);
    expect(result.success).toBe(true);
  });

  it("parses new failure receipt with errorEnvelope field", () => {
    const newDetail = syntheticNewFailureDetail();
    const result = safeRequestFailureSchema.safeParse(newDetail);
    expect(result.success).toBe(true);
  });

  it("rejects failure receipt with invalid errorEnvelope classification", () => {
    const badDetail = {
      ...syntheticNewFailureDetail(),
      firstRejectedEvent: {
        ...syntheticNewFailureDetail().firstRejectedEvent!,
        errorEnvelope: {
          present: true,
          classification: "INVALID_CLASSIFICATION",
          fieldCount: 0,
          allowedFields: [],
          allowedNestedObjectKeys: [],
          unknownFieldCount: 0,
          unknownKeysFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
          envelopeFingerprint: "0000000000000000000000000000000000000000000000000000000000000000"
        }
      }
    };
    const result = safeRequestFailureSchema.safeParse(badDetail);
    expect(result.success).toBe(false);
  });
});

describe("Schema compatibility: strict legacy vs current union reader", () => {
  it("reader accepts legacy ae47bbc format (raw arrays, no count/fingerprint, no errorEnvelope)", () => {
    const legacy = syntheticLegacyAe47bbcFailureDetail();
    const result = safeRequestFailureReadSchema.safeParse(legacy);
    expect(result.success).toBe(true);
  });

  it("reader accepts current safe format (count/fingerprint + errorEnvelope)", () => {
    const current = syntheticNewFailureDetail();
    const result = safeRequestFailureReadSchema.safeParse(current);
    expect(result.success).toBe(true);
  });

  it("writer rejects legacy ae47bbc format — only current format accepted for new records", () => {
    const legacy = syntheticLegacyAe47bbcFailureDetail();
    const result = safeRequestFailureSchema.safeParse(legacy);
    expect(result.success).toBe(false);
  });

  it("reader rejects hybrid record (raw arrays + count/fingerprint present simultaneously)", () => {
    const legacy = syntheticLegacyAe47bbcFailureDetail();
    // Inject current count/fingerprint fields into the legacy structure — hybrid
    const hybrid = {
      ...legacy,
      firstRejectedEvent: {
        ...legacy.firstRejectedEvent!,
        unknownTopLevelKeyCount: 0,
        unknownTopLevelKeysFingerprint: "0".repeat(64),
        structure: {
          ...legacy.firstRejectedEvent!.structure,
          unknownTopLevelKeyCount: 0,
          unknownTopLevelKeysFingerprint: "0".repeat(64)
        }
      }
    };
    const result = safeRequestFailureReadSchema.safeParse(hybrid);
    expect(result.success).toBe(false);
  });

  it("reader rejects malformed record with invalid shape enum", () => {
    const malformed = {
      ...syntheticLegacyAe47bbcFailureDetail(),
      firstRejectedEvent: {
        ...syntheticLegacyAe47bbcFailureDetail().firstRejectedEvent!,
        shape: "INVALID_SHAPE"
      }
    };
    const result = safeRequestFailureReadSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it("sentinel privacy: PRIVATE_FIELD_NAME absent from current audit and legacy fixture contains no private content", () => {
    const privateFieldName = "PRIVATE_FIELD_NAME";
    const event = `data: ${JSON.stringify({
      error: "synthetic",
      [privateFieldName]: "synthetic-private-value"
    })}\n\n`;
    const audit = describeRejectedSseEvent(event, 1);
    expect(JSON.stringify(audit)).not.toContain(privateFieldName);
    const legacy = syntheticLegacyAe47bbcFailureDetail();
    expect(JSON.stringify(legacy)).not.toContain(privateFieldName);
  });
});

describe("Checkpoint read path: legacy ae47bbc through actual privateCheckpointReadSchema", () => {
  // Build a minimal content-free phase0 checkpoint wrapping a legacy failure detail
  function buildLegacyCheckpoint() {
    const legacyDetail = syntheticLegacyAe47bbcFailureDetail();
    return {
      schemaVersion: 1,
      profileName: "development-smoke-6x4-v1",
      profileFingerprint: "a".repeat(64),
      manifestFingerprint: "b".repeat(64),
      privateManifestFileSha256: "c".repeat(64),
      runId: "d".repeat(64),
      runBindingHash: "e".repeat(64),
      codeVersion: "f".repeat(40),
      phase: "phase0",
      state: "incomplete",
      revision: 1,
      previousCheckpointSha256: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      requests: [
        {
          receipt: {
            schemaVersion: 1,
            profileName: "development-smoke-6x4-v1",
            profileFingerprint: "a".repeat(64),
            manifestFingerprint: "b".repeat(64),
            runBindingHash: "e".repeat(64),
            anonymousSlot: "slot-01",
            phase: "phase0",
            stage: "A",
            provider: "aether",
            model: "deepseek-v4-pro",
            modelFingerprint: "9".repeat(64),
            schemaFingerprint: "2".repeat(64),
            maxOutputTokens: 32_000,
            thinkingRequest: "enabled",
            reasoningEffort: "max",
            logicalAttempt: 1,
            logicalRequestsUsed: 1,
            logicalRequestCeiling: 30,
            externalAttemptsUsed: 1,
            externalAttemptCeiling: 30
          },
          failureKind: legacyDetail.kind,
          failureDetail: legacyDetail
        }
      ],
      phase0Forecast: null,
      stopReason: "final_failure",
      failureCode: "final_failure",
      failureLocation: "test.ts:1:test",
      accuracyClaim: null,
      includedInFinalCalibration: false,
      phase1Released: false
    };
  }

  function buildCurrentCheckpoint() {
    const currentDetail = syntheticNewFailureDetail();
    return {
      ...buildLegacyCheckpoint(),
      requests: [
        {
          receipt: buildLegacyCheckpoint().requests[0].receipt,
          failureKind: currentDetail.kind,
          failureDetail: currentDetail
        }
      ]
    };
  }

  it("actual read path accepts full ae47bbc-shaped checkpoint", () => {
    const checkpoint = buildLegacyCheckpoint();
    const result = privateCheckpointReadSchema.safeParse(checkpoint);
    expect(result.success).toBe(true);
  });
  it("actual read path accepts current safe checkpoint", () => {
    const checkpoint = buildCurrentCheckpoint();
    const result = privateCheckpointReadSchema.safeParse(checkpoint);
    expect(result.success).toBe(true);
  });

  it("actual read path rejects full hybrid checkpoint (raw arrays + count/fingerprint)", () => {
    const legacy = buildLegacyCheckpoint();
    const legacyDetail = legacy.requests[0].failureDetail!;
    // Inject count/fingerprint into the legacy structure's firstRejectedEvent — hybrid
    const hybridCheckpoint = {
      ...legacy,
      requests: [
        {
          ...legacy.requests[0],
          failureDetail: {
            ...legacyDetail,
            firstRejectedEvent: {
              ...legacyDetail.firstRejectedEvent!,
              unknownTopLevelKeyCount: 0,
              unknownTopLevelKeysFingerprint: "0".repeat(64),
              structure: {
                ...legacyDetail.firstRejectedEvent!.structure,
                unknownTopLevelKeyCount: 0,
                unknownTopLevelKeysFingerprint: "0".repeat(64)
              }
            }
          }
        }
      ]
    };
    const result = privateCheckpointReadSchema.safeParse(hybridCheckpoint);
    expect(result.success).toBe(false);
  });

  it("current write schema rejects legacy ae47bbc checkpoint", () => {
    const checkpoint = buildLegacyCheckpoint();
    // safeRequestFailureSchema is current-only — legacy detail embedded should fail
    const legacyDetail = checkpoint.requests[0].failureDetail!;
    const result = safeRequestFailureSchema.safeParse(legacyDetail);
    expect(result.success).toBe(false);
  });

  it("sentinel privacy: PRIVATE_FIELD_NAME absent from full legacy checkpoint serialization", () => {
    const checkpoint = buildLegacyCheckpoint();
    expect(JSON.stringify(checkpoint)).not.toContain("PRIVATE_FIELD_NAME");
    const result = privateCheckpointReadSchema.safeParse(checkpoint);
    expect(result.success).toBe(true);
  });
});
