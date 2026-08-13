import { z } from "zod";

export const developmentDiagnosticSlotSchema = z.enum(["slot-01", "slot-02"]);
export type DevelopmentDiagnosticSelectedSlot = z.infer<
  typeof developmentDiagnosticSlotSchema
>;

export const developmentDiagnosticExpectedRequestsPerSlot = 12 as const;
export const developmentDiagnosticMaximumSafeConcurrency = 16 as const;
export const developmentDiagnosticMaximumSchedulingBudgetMs = 180 * 60 * 1_000;

export const developmentDiagnosticPlannedRunContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    selectedSlots: z.array(developmentDiagnosticSlotSchema).min(1).max(2).readonly(),
    expectedRequestsPerSlot: z.literal(developmentDiagnosticExpectedRequestsPerSlot),
    maximumConcurrency: z.number().int().min(1).max(developmentDiagnosticMaximumSafeConcurrency),
    maximumTransportAttemptsPerRequest: z.number().int().min(1).max(2),
    globalTransportAttemptCeiling: z.number().int().min(1).max(104),
    phaseSchedulingBudgetMs: z
      .number()
      .int()
      .min(1)
      .max(developmentDiagnosticMaximumSchedulingBudgetMs),
    softStopPolicy: z.enum([
      "deny_next_transport",
      "stop_new_and_drain_in_flight"
    ])
  })
  .strict()
  .superRefine((value, context) => {
    const uniqueSlots = new Set(value.selectedSlots);
    const canonicalSlots = [...value.selectedSlots].sort();
    if (
      uniqueSlots.size !== value.selectedSlots.length ||
      canonicalSlots.some((slot, index) => slot !== value.selectedSlots[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedSlots"],
        message: "selected slots must be unique and canonical"
      });
    }
    const expectedRequests =
      value.selectedSlots.length * value.expectedRequestsPerSlot;
    if (value.globalTransportAttemptCeiling < expectedRequests) {
      context.addIssue({
        code: "custom",
        path: ["globalTransportAttemptCeiling"],
        message: "transport ceiling cannot cover expected requests"
      });
    }
    if (
      value.maximumTransportAttemptsPerRequest > 1 &&
      value.globalTransportAttemptCeiling <= expectedRequests
    ) {
      context.addIssue({
        code: "custom",
        path: ["globalTransportAttemptCeiling"],
        message: "transport ceiling has no retry allowance"
      });
    }
  });

export type DevelopmentDiagnosticPlannedRunContract = z.infer<
  typeof developmentDiagnosticPlannedRunContractSchema
>;

export const legacyDevelopmentDiagnosticPlannedRunContract = Object.freeze({
  schemaVersion: 1 as const,
  selectedSlots: Object.freeze(["slot-01", "slot-02"] as const),
  expectedRequestsPerSlot: developmentDiagnosticExpectedRequestsPerSlot,
  maximumConcurrency: 4,
  maximumTransportAttemptsPerRequest: 1,
  globalTransportAttemptCeiling: 52,
  phaseSchedulingBudgetMs: 60 * 60 * 1_000,
  softStopPolicy: "deny_next_transport" as const
});

export function parseDevelopmentDiagnosticPlannedRunContract(
  candidate: unknown
): DevelopmentDiagnosticPlannedRunContract {
  return developmentDiagnosticPlannedRunContractSchema.parse(candidate);
}

export function developmentDiagnosticExpectedRequestCount(
  contract: DevelopmentDiagnosticPlannedRunContract
): number {
  return contract.selectedSlots.length * contract.expectedRequestsPerSlot;
}
