import { z } from "zod";
import {
  failPhysicalBlind,
  hashPhysicalBlindValue
} from "./physical-blind-common";

export const physicalBlindProfileNameSchema = z.enum([
  "difficulty",
  "levels",
  "verdict"
]);
export type PhysicalBlindProfileName = z.infer<
  typeof physicalBlindProfileNameSchema
>;

export const physicalBlindProfileImplementationVersion =
  "physical-blind-score-profiles-v2" as const;

export interface PhysicalBlindProfileAssessment {
  readonly sampleCount: number;
  readonly minimumSampleSizeMet: boolean;
  readonly accuracyPassed: boolean;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface PhysicalBlindProfile {
  readonly name: PhysicalBlindProfileName;
  readonly implementationVersion: typeof physicalBlindProfileImplementationVersion;
  readonly specificationFingerprint: string;
  readonly scoringAvailable: boolean;
  readonly unavailableReasonCode?: "BLIND_PROFILE_TREATMENT_UNBOUND";
  readonly predictionSchema: z.ZodType<unknown>;
  readonly goldSchema: z.ZodType<unknown>;
  readonly assess: (
    rows: readonly {
      readonly prediction: unknown;
      readonly gold: unknown;
    }[]
  ) => PhysicalBlindProfileAssessment;
}

const difficultySpecification = {
  schemaVersion: 1,
  expectedProblemCount: 83,
  maximumMeanAbsoluteError: 200,
  minimumHitRateWithin200: 0.75
} as const;
const difficultyPredictionSchema = z
  .object({
    rating: z.number().int().min(800).max(3500).multipleOf(100),
    confidence: z.number().finite().min(0).max(1)
  })
  .strict();
const difficultyGoldSchema = z
  .object({ officialRating: z.number().int().min(800).max(3500) })
  .strict();

const levelsSpecification = {
  schemaVersion: 1,
  minimumProblemCount: 60,
  minimumExactRate: 0.6,
  minimumWithinOneRate: 0.9,
  maximumMeanAbsoluteError: 0.6
} as const;
const levelsPredictionSchema = z
  .object({
    thinkingLevel: z.number().int().min(1).max(5),
    codingLevel: z.number().int().min(1).max(5)
  })
  .strict();
const levelsGoldSchema = z
  .object({
    humanThinkingLevel: z.number().int().min(1).max(5),
    humanCodingLevel: z.number().int().min(1).max(5)
  })
  .strict();

const verdictSpecification = {
  schemaVersion: 1,
  scoringAvailable: false,
  reasonCode: "BLIND_PROFILE_TREATMENT_UNBOUND"
} as const;
const verdictPredictionSchema = z
  .object({
    verdict: z.enum(["approve", "request_changes", "reject"]),
    forcedDuplicateReject: z.boolean()
  })
  .strict();
const verdictGoldSchema = z
  .object({
    expectedVerdict: z.enum(["not_reject", "reject"]),
    expectedForcedDuplicateReject: z.boolean()
  })
  .strict();

const profiles: Readonly<Record<PhysicalBlindProfileName, PhysicalBlindProfile>> = {
  difficulty: {
    name: "difficulty",
    implementationVersion: physicalBlindProfileImplementationVersion,
    specificationFingerprint: hashPhysicalBlindValue(difficultySpecification),
    scoringAvailable: true,
    predictionSchema: difficultyPredictionSchema,
    goldSchema: difficultyGoldSchema,
    assess: (rows) => {
      const parsed = rows.map((row) => ({
        prediction: difficultyPredictionSchema.parse(row.prediction),
        gold: difficultyGoldSchema.parse(row.gold)
      }));
      const meanAbsoluteError = parsed.length === 0
        ? Number.POSITIVE_INFINITY
        : parsed.reduce(
            (sum, row) =>
              sum + Math.abs(row.prediction.rating - row.gold.officialRating),
            0
          ) / parsed.length;
      const hitRateWithin200 = parsed.length === 0
        ? 0
        : parsed.filter(
            (row) =>
              Math.abs(row.prediction.rating - row.gold.officialRating) <= 200
          ).length / parsed.length;
      const minimumSampleSizeMet =
        parsed.length === difficultySpecification.expectedProblemCount;
      return {
        sampleCount: parsed.length,
        minimumSampleSizeMet,
        accuracyPassed:
          minimumSampleSizeMet &&
          meanAbsoluteError <=
            difficultySpecification.maximumMeanAbsoluteError &&
          hitRateWithin200 >= difficultySpecification.minimumHitRateWithin200,
        metrics: { meanAbsoluteError, hitRateWithin200 }
      };
    }
  },
  levels: {
    name: "levels",
    implementationVersion: physicalBlindProfileImplementationVersion,
    specificationFingerprint: hashPhysicalBlindValue(levelsSpecification),
    scoringAvailable: true,
    predictionSchema: levelsPredictionSchema,
    goldSchema: levelsGoldSchema,
    assess: (rows) => {
      const parsed = rows.map((row) => ({
        prediction: levelsPredictionSchema.parse(row.prediction),
        gold: levelsGoldSchema.parse(row.gold)
      }));
      const thinking = levelMetrics(
        parsed.map((row) => [
          row.prediction.thinkingLevel,
          row.gold.humanThinkingLevel
        ])
      );
      const coding = levelMetrics(
        parsed.map((row) => [
          row.prediction.codingLevel,
          row.gold.humanCodingLevel
        ])
      );
      const minimumSampleSizeMet =
        parsed.length >= levelsSpecification.minimumProblemCount;
      const passes = (metrics: ReturnType<typeof levelMetrics>) =>
        metrics.exactRate >= levelsSpecification.minimumExactRate &&
        metrics.withinOneRate >= levelsSpecification.minimumWithinOneRate &&
        metrics.meanAbsoluteError <=
          levelsSpecification.maximumMeanAbsoluteError;
      return {
        sampleCount: parsed.length,
        minimumSampleSizeMet,
        accuracyPassed:
          minimumSampleSizeMet && passes(thinking) && passes(coding),
        metrics: {
          thinkingExactRate: thinking.exactRate,
          thinkingWithinOneRate: thinking.withinOneRate,
          thinkingMeanAbsoluteError: thinking.meanAbsoluteError,
          codingExactRate: coding.exactRate,
          codingWithinOneRate: coding.withinOneRate,
          codingMeanAbsoluteError: coding.meanAbsoluteError
        }
      };
    }
  },
  verdict: {
    name: "verdict",
    implementationVersion: physicalBlindProfileImplementationVersion,
    specificationFingerprint: hashPhysicalBlindValue(verdictSpecification),
    scoringAvailable: false,
    unavailableReasonCode: "BLIND_PROFILE_TREATMENT_UNBOUND",
    predictionSchema: verdictPredictionSchema,
    goldSchema: verdictGoldSchema,
    assess: (rows) => {
      void rows;
      return failPhysicalBlind("BLIND_PROFILE_TREATMENT_UNBOUND");
    }
  }
};

export function physicalBlindProfile(name: string): PhysicalBlindProfile {
  const parsed = physicalBlindProfileNameSchema.safeParse(name);
  if (!parsed.success) {
    failPhysicalBlind("BLIND_CLI_PROFILE_INVALID");
  }
  return profiles[parsed.data];
}

function levelMetrics(rows: readonly (readonly [number, number])[]): {
  readonly exactRate: number;
  readonly withinOneRate: number;
  readonly meanAbsoluteError: number;
} {
  if (rows.length === 0) {
    return {
      exactRate: 0,
      withinOneRate: 0,
      meanAbsoluteError: Number.POSITIVE_INFINITY
    };
  }
  const errors = rows.map(([prediction, gold]) => Math.abs(prediction - gold));
  return {
    exactRate: errors.filter((error) => error === 0).length / errors.length,
    withinOneRate: errors.filter((error) => error <= 1).length / errors.length,
    meanAbsoluteError:
      errors.reduce((sum, error) => sum + error, 0) / errors.length
  };
}
