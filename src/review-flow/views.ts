import type { EvidenceArtifact } from "./evidence";
import { deepFreeze } from "./evidence";
import {
  reviewFlowSourceSchema,
  statementOnlyViewSchema,
  type AdversaryPayload,
  type ContestFitPayload,
  type CriticPayload,
  type DifficultyPayload,
  type EditorialPayload,
  type OriginalityPayload,
  type ReviewFlowSource,
  type SolutionAnalystPayload,
  type SolverPayload,
  type StatementOnlyView,
  type TagsPayload,
  type TechnicalAuditPayload
} from "./schemas";

export interface SolutionAnalystView {
  readonly statement: StatementOnlyView;
  readonly officialSolution: string;
  readonly solver: EvidenceArtifact<SolverPayload>;
}

export interface TechnicalAuditorView {
  readonly statement: StatementOnlyView;
  readonly officialSolution: string;
  /** 外部角色只能看到存在性元数据；源码只允许未来的本地可信执行旁路读取。 */
  readonly referenceImplementation: {
    readonly provided: boolean;
    readonly language: string | null;
    readonly sourceLength: number | null;
  };
  readonly solver: EvidenceArtifact<SolverPayload>;
  readonly solutionAnalyst: EvidenceArtifact<SolutionAnalystPayload>;
}

export interface DifficultyView {
  readonly statement: StatementOnlyView;
  readonly solver: EvidenceArtifact<SolverPayload>;
  readonly solutionAnalyst: EvidenceArtifact<SolutionAnalystPayload>;
  readonly technicalAudit: EvidenceArtifact<TechnicalAuditPayload>;
}

export interface EditorialJudgeView {
  readonly statement: StatementOnlyView;
  readonly officialSolution: string;
  readonly solver: EvidenceArtifact<SolverPayload>;
  readonly solutionAnalyst: EvidenceArtifact<SolutionAnalystPayload>;
  readonly technicalAudit: EvidenceArtifact<TechnicalAuditPayload>;
}

export type ContestFitView = EditorialJudgeView;

export interface OriginalityView {
  readonly statement: StatementOnlyView;
  readonly duplicateEvidence: ReviewFlowSource["duplicateEvidence"];
}

export interface TagsView {
  readonly statement: StatementOnlyView;
  readonly officialSolution: string;
  readonly tagCatalogVersion: number;
  readonly tagCatalog: ReviewFlowSource["tagCatalog"];
}

export interface CriticView {
  readonly problemContentHash: string;
  readonly evidence: readonly EvidenceArtifact<unknown>[];
}

export type AdversaryView = CriticView;

export interface AdjudicatorView extends AdversaryView {
  readonly critic: EvidenceArtifact<CriticPayload>;
  readonly adversary: EvidenceArtifact<AdversaryPayload>;
}

export function freezeReviewFlowSource(candidate: unknown): ReviewFlowSource {
  return deepFreeze(reviewFlowSourceSchema.parse(structuredClone(candidate)));
}

export function buildStatementOnlyView(source: ReviewFlowSource): StatementOnlyView {
  return deepFreeze(statementOnlyViewSchema.parse({
    schemaVersion: 1,
    problemContentHash: source.problemContentHash,
    type: source.type,
    statement: source.statement,
    constraints: source.constraints,
    samples: source.samples,
    limits: source.limits
  }));
}

export function buildSolutionAnalystView(
  source: ReviewFlowSource,
  statement: StatementOnlyView,
  solver: EvidenceArtifact<SolverPayload>
): SolutionAnalystView {
  return deepFreeze({
    statement,
    officialSolution: source.solution,
    solver
  });
}

export function buildTechnicalAuditorView(input: {
  readonly source: ReviewFlowSource;
  readonly statement: StatementOnlyView;
  readonly solver: EvidenceArtifact<SolverPayload>;
  readonly solutionAnalyst: EvidenceArtifact<SolutionAnalystPayload>;
}): TechnicalAuditorView {
  return deepFreeze({
    statement: input.statement,
    officialSolution: input.source.solution,
    referenceImplementation: input.source.referenceImplementation === null
      ? { provided: false, language: null, sourceLength: null }
      : {
          provided: true,
          language: input.source.referenceImplementation.language,
          sourceLength: input.source.referenceImplementation.source.length
        },
    solver: input.solver,
    solutionAnalyst: input.solutionAnalyst
  });
}

export function buildDifficultyView(input: {
  readonly statement: StatementOnlyView;
  readonly solver: EvidenceArtifact<SolverPayload>;
  readonly solutionAnalyst: EvidenceArtifact<SolutionAnalystPayload>;
  readonly technicalAudit: EvidenceArtifact<TechnicalAuditPayload>;
}): DifficultyView {
  return deepFreeze({ ...input });
}

export function buildEditorialJudgeView(input: {
  readonly source: ReviewFlowSource;
  readonly statement: StatementOnlyView;
  readonly solver: EvidenceArtifact<SolverPayload>;
  readonly solutionAnalyst: EvidenceArtifact<SolutionAnalystPayload>;
  readonly technicalAudit: EvidenceArtifact<TechnicalAuditPayload>;
}): EditorialJudgeView {
  return deepFreeze({
    statement: input.statement,
    officialSolution: input.source.solution,
    solver: input.solver,
    solutionAnalyst: input.solutionAnalyst,
    technicalAudit: input.technicalAudit
  });
}

export function buildContestFitView(input: {
  readonly source: ReviewFlowSource;
  readonly statement: StatementOnlyView;
  readonly solver: EvidenceArtifact<SolverPayload>;
  readonly solutionAnalyst: EvidenceArtifact<SolutionAnalystPayload>;
  readonly technicalAudit: EvidenceArtifact<TechnicalAuditPayload>;
}): ContestFitView {
  return buildEditorialJudgeView(input);
}

export function buildOriginalityView(
  source: ReviewFlowSource,
  statement: StatementOnlyView
): OriginalityView {
  return deepFreeze({ statement, duplicateEvidence: source.duplicateEvidence });
}

export function buildTagsView(
  source: ReviewFlowSource,
  statement: StatementOnlyView
): TagsView {
  return deepFreeze({
    statement,
    officialSolution: source.solution,
    tagCatalogVersion: source.tagCatalogVersion,
    tagCatalog: source.tagCatalog
  });
}

export function buildCriticView(
  problemContentHash: string,
  evidence: readonly EvidenceArtifact<unknown>[]
): CriticView {
  return deepFreeze({ problemContentHash, evidence: [...evidence] });
}

export function buildAdversaryView(
  criticView: CriticView
): AdversaryView {
  return deepFreeze({ ...criticView });
}

export function buildAdjudicatorView(
  criticView: CriticView,
  critic: EvidenceArtifact<CriticPayload>,
  adversary: EvidenceArtifact<AdversaryPayload>
): AdjudicatorView {
  return deepFreeze({ ...criticView, critic, adversary });
}

export type IndependentEvidencePayload =
  | ContestFitPayload
  | DifficultyPayload
  | EditorialPayload
  | OriginalityPayload
  | TagsPayload;
