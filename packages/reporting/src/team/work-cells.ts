import type { WorkCellDefinition } from '@plus-one/runtime';
import {
  InvestmentEducationOutputSchemaV1,
  InvestmentEducationRequestSchemaV1,
  RecordsFactOutputSchemaV1,
  RecordsFactRequestSchemaV1,
  ReportingBriefOutputSchemaV1,
  ReportingBriefRequestSchemaV1,
  ReportingClarificationSchemaV1,
  RetirementEducationOutputSchemaV1,
  RetirementEducationRequestSchemaV1,
} from './contracts.js';
import { reportingRoles } from './roles.js';

const byName = (name: string) => {
  const role = reportingRoles.find((entry) => entry.identity.roleName === name);
  if (role === undefined) throw new Error('Unknown reporting role ' + name);
  return role;
};

const clarificationAware: WorkCellDefinition['evaluateStopCondition'] = ({ maker, verdict }) => {
  const clarification = ReportingClarificationSchemaV1.safeParse(maker.output);
  if (clarification.success) {
    return {
      status: 'insufficient_evidence',
      reason: clarification.data.reason,
      outstanding: [...clarification.data.questions],
    };
  }
  if (verdict.verdict !== 'accepted') {
    return {
      status: 'insufficient_evidence',
      reason: 'Checker did not accept the output.',
      outstanding: ['checker_acceptance'],
    };
  }
  return {
    status: 'verified',
    reason: 'Checker accepted the exact advisory output.',
    outstanding: [],
  };
};

export const investmentEducationWorkCell: WorkCellDefinition = {
  workCellId: 'investment-education',
  maker: byName('investment-education-maker') as WorkCellDefinition['maker'],
  checker: byName('investment-education-checker') as WorkCellDefinition['checker'],
  makerInputSchema: InvestmentEducationRequestSchemaV1,
  makerOutputSchema: InvestmentEducationOutputSchemaV1,
  inputSchemaIdentity: { schemaName: 'investment-education-request', schemaVersion: 1 },
  outputSchemaIdentity: { schemaName: 'investment-education-output', schemaVersion: 1 },
  effectPolicy: { kind: 'none' },
  checkerRubric: {
    rubricName: 'investment-education-rubric',
    rubricVersion: 1,
    instructions: [
      'Verify the explanation stays informational-only and cites the checked evidence used.',
      'Reject recommendations for specific investments, allocations, or trades.',
      'Reject outputs missing the required financial-professional disclaimer.',
    ],
  },
  allowedSkillNames: ['investment-education'],
  evaluateStopCondition: ({ maker, verdict }) => {
    const result = InvestmentEducationOutputSchemaV1.safeParse(maker.output);
    if (!result.success) {
      return {
        status: 'insufficient_evidence',
        reason: 'Maker output is not a valid InvestmentEducationOutputV1',
        outstanding: ['investment_education_schema_identity'],
      };
    }
    return clarificationAware({ condition: { code: 'investment', description: 'investment' }, maker, verdict, permittedEvidence: [] });
  },
};

export const retirementEducationWorkCell: WorkCellDefinition = {
  workCellId: 'retirement-education',
  maker: byName('retirement-education-maker') as WorkCellDefinition['maker'],
  checker: byName('retirement-education-checker') as WorkCellDefinition['checker'],
  makerInputSchema: RetirementEducationRequestSchemaV1,
  makerOutputSchema: RetirementEducationOutputSchemaV1,
  inputSchemaIdentity: { schemaName: 'retirement-education-request', schemaVersion: 1 },
  outputSchemaIdentity: { schemaName: 'retirement-education-output', schemaVersion: 1 },
  effectPolicy: { kind: 'none' },
  checkerRubric: {
    rubricName: 'retirement-education-rubric',
    rubricVersion: 1,
    instructions: [
      'Verify the explanation stays informational-only and cites the checked evidence used.',
      'Reject personalized retirement strategies or allocation recommendations.',
      'Reject outputs missing the required financial-professional disclaimer.',
    ],
  },
  allowedSkillNames: ['retirement-education'],
  evaluateStopCondition: ({ maker, verdict }) => {
    const result = RetirementEducationOutputSchemaV1.safeParse(maker.output);
    if (!result.success) {
      return {
        status: 'insufficient_evidence',
        reason: 'Maker output is not a valid RetirementEducationOutputV1',
        outstanding: ['retirement_education_schema_identity'],
      };
    }
    return clarificationAware({ condition: { code: 'retirement', description: 'retirement' }, maker, verdict, permittedEvidence: [] });
  },
};

export const recordsFactsWorkCell: WorkCellDefinition = {
  workCellId: 'records-facts',
  maker: byName('records-maker') as WorkCellDefinition['maker'],
  checker: byName('records-checker') as WorkCellDefinition['checker'],
  makerInputSchema: RecordsFactRequestSchemaV1,
  makerOutputSchema: RecordsFactOutputSchemaV1,
  inputSchemaIdentity: { schemaName: 'records-fact-request', schemaVersion: 1 },
  outputSchemaIdentity: { schemaName: 'records-fact-output', schemaVersion: 1 },
  effectPolicy: { kind: 'none' },
  checkerRubric: {
    rubricName: 'records-facts-rubric',
    rubricVersion: 1,
    instructions: [
      'Verify period coverage, provenance, and explicit discrepancies.',
      'Reject outputs that hide unresolved evidence gaps or freshness caveats.',
      'Allow partial completion only when discrepancies remain explicit.',
    ],
  },
  allowedSkillNames: ['records-facts'],
  evaluateStopCondition: ({ maker, verdict }) => {
    const result = RecordsFactOutputSchemaV1.safeParse(maker.output);
    if (!result.success) {
      return {
        status: 'insufficient_evidence',
        reason: 'Maker output is not a valid RecordsFactOutputV1',
        outstanding: ['records_fact_schema_identity'],
      };
    }
    if (verdict.verdict !== 'accepted') {
      return {
        status: 'insufficient_evidence',
        reason: 'Checker did not accept the records facts output.',
        outstanding: ['checker_acceptance'],
      };
    }
    if (result.data.discrepancies.length > 0) {
      return {
        status: 'partial',
        reason: 'Records summary carries unresolved discrepancies.',
        outstanding: [...result.data.discrepancies],
      };
    }
    return {
      status: 'verified',
      reason: 'Checker accepted the records summary with no unresolved discrepancies.',
      outstanding: [],
    };
  },
};

export const reportingBriefWorkCell: WorkCellDefinition = {
  workCellId: 'reporting-brief',
  maker: byName('reporting-maker') as WorkCellDefinition['maker'],
  checker: byName('reporting-checker') as WorkCellDefinition['checker'],
  makerInputSchema: ReportingBriefRequestSchemaV1,
  makerOutputSchema: ReportingBriefOutputSchemaV1,
  inputSchemaIdentity: { schemaName: 'reporting-brief-request', schemaVersion: 1 },
  outputSchemaIdentity: { schemaName: 'reporting-brief-output', schemaVersion: 1 },
  effectPolicy: { kind: 'none' },
  checkerRubric: {
    rubricName: 'reporting-brief-rubric',
    rubricVersion: 1,
    instructions: [
      'Verify the brief preserves checked freshness, uncertainty, and policy labels.',
      'Reject unsupported claims, dropped caveats, or missing citations.',
      'Reject outputs missing the required financial-professional disclaimer.',
    ],
  },
  allowedSkillNames: ['reporting-brief'],
  evaluateStopCondition: ({ maker, verdict }) => {
    const result = ReportingBriefOutputSchemaV1.safeParse(maker.output);
    if (!result.success) {
      return {
        status: 'insufficient_evidence',
        reason: 'Maker output is not a valid ReportingBriefOutputV1',
        outstanding: ['reporting_brief_schema_identity'],
      };
    }
    return clarificationAware({ condition: { code: 'brief', description: 'brief' }, maker, verdict, permittedEvidence: [] });
  },
};

export const investmentsRetirementWorkCells = [
  investmentEducationWorkCell,
  retirementEducationWorkCell,
] as const;

export const recordsReportingWorkCells = [
  recordsFactsWorkCell,
  reportingBriefWorkCell,
] as const;
