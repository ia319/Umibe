import { createHash, randomUUID } from 'node:crypto';
import { ActionRegistry } from '#internal/action/registry';
import type { PreparedAction } from '#internal/contracts/action';
import type { CallControl } from '#internal/contracts/control';
import type { CandidateProvider } from '#internal/contracts/adapters';
import type {
  Candidate,
  CandidateExclusion,
  CandidateSet,
} from '#internal/contracts/candidate';
import type {
  CandidateGenerationInput,
  CandidatePreparationEntry,
  CandidatePreparationReport,
  CandidatePreparationResult,
} from '#internal/contracts/candidate-processing';
import { ContractError } from '#internal/errors';
import { parseCandidateSet } from '#internal/validation/candidate';
import { captureCandidateRequest, validateCandidateBasis } from './context.js';
import { captureControl, invokeControlled } from './control.js';
import { candidateContractIssue, invocationFailure } from './diagnostics.js';
import { registerPreparedCandidates } from './handles.js';
import { canonicalJson } from './identity.js';

interface NormalizedProposal {
  readonly index: number;
  readonly candidate: Candidate;
  readonly action: PreparedAction;
}

interface CallGroup {
  readonly canonical: string;
  readonly metadata: string;
  readonly proposals: NormalizedProposal[];
  conflict: boolean;
}

/**
 * Generate and normalize one candidate batch, preserving its complete decision
 * basis and provider provenance. Caller input is captured before the first await.
 * Invalid input rejects with ContractError; provider failures return a failure
 * outcome with partial diagnostics. Preparation never calls check or execute.
 */
export async function prepareCandidates(
  input: CandidateGenerationInput,
  registry: ActionRegistry,
  provider: CandidateProvider,
  controlInput: CallControl,
): Promise<CandidatePreparationResult> {
  if (!(registry instanceof ActionRegistry)) {
    throw new ContractError(
      'INVALID_CANDIDATE_REQUEST',
      'candidate_request',
      '/registry',
      'expected_action_registry',
    );
  }
  if (
    typeof provider !== 'object' ||
    provider === null ||
    typeof provider.generate !== 'function'
  ) {
    throw new ContractError(
      'INVALID_CANDIDATE_REQUEST',
      'candidate_request',
      '/provider',
      'expected_candidate_provider',
    );
  }
  const generate = provider.generate.bind(provider);
  const request = captureCandidateRequest(input, registry.capabilities);
  const control = captureControl(controlInput);
  const prepare = registry.prepare.bind(registry);
  const available = new Set(
    request.capabilities.map((capability) => capability.id),
  );
  const groups = new Map<string, CallGroup>();
  const rejected = new Map<number, CandidatePreparationEntry>();
  let providerSet: CandidateSet | null = null;
  let normalized = 0;

  // Finalize whole duplicate groups together so conflicting metadata never leaves
  // the first proposal accidentally eligible. Retain a report on interruption too.
  const snapshotReport = (): CandidatePreparationReport => {
    const entries = new Map(rejected);
    for (const [callId, group] of groups) {
      for (const [position, proposal] of group.proposals.entries()) {
        entries.set(
          proposal.index,
          Object.freeze({
            candidateId: proposal.candidate.id,
            callId,
            outcome: group.conflict
              ? 'excluded'
              : position === 0
                ? 'prepared'
                : 'merged',
            reason: group.conflict
              ? 'conflicting_candidate_metadata'
              : position === 0
                ? null
                : 'duplicate_call',
            issue: null,
            parameterChanges: proposal.action.call.parameterChanges,
          }),
        );
      }
    }
    const ordered = [...entries]
      .sort(([left], [right]) => left - right)
      .map(([, entry]) => entry);
    return Object.freeze({
      received: providerSet?.candidates.length ?? null,
      normalized,
      merged: ordered.filter((entry) => entry.outcome === 'merged').length,
      excluded: ordered.filter((entry) => entry.outcome === 'excluded').length,
      remaining:
        providerSet === null
          ? null
          : providerSet.candidates.length - ordered.length,
      entries: Object.freeze(ordered),
    });
  };

  const generated = await invokeControlled<unknown>(control, (control) =>
    generate(request, control),
  );
  if (generated.outcome !== 'returned') {
    return Object.freeze({
      ...invocationFailure(generated, 'generation', null),
      request,
      providerSet,
      report: snapshotReport(),
    });
  }
  try {
    const parsed = parseCandidateSet(generated.value);
    validateCandidateBasis(parsed, request);
    providerSet = parsed;
  } catch (error) {
    return Object.freeze({
      outcome: 'failed',
      stage: 'generation',
      candidateId: null,
      reason: 'invalid_result',
      issue: candidateContractIssue(error),
      request,
      providerSet,
      report: snapshotReport(),
    });
  }

  for (const [index, candidate] of providerSet.candidates.entries()) {
    const prepared = await invokeControlled(control, () => {
      // Actions registered after generation started were not in the provider's catalog.
      if (!available.has(candidate.actionId)) {
        throw new ContractError(
          'INVALID_ACTION_PARAMETERS',
          'action_parameters',
          '/actionId',
          'unknown_action',
        );
      }
      return prepare({
        actionId: candidate.actionId,
        actionVersion: candidate.actionVersion,
        params: candidate.params,
        paramSources: candidate.paramSources,
      });
    });
    if (prepared.outcome !== 'returned') {
      if (
        prepared.outcome === 'failed' &&
        prepared.error instanceof ContractError
      ) {
        rejected.set(
          index,
          Object.freeze({
            candidateId: candidate.id,
            callId: null,
            outcome: 'excluded',
            reason: prepared.error.reason,
            issue: candidateContractIssue(prepared.error),
            parameterChanges: Object.freeze([]),
          }),
        );
        continue;
      }
      return Object.freeze({
        ...invocationFailure(prepared, 'preparation', candidate.id),
        request,
        providerSet,
        report: snapshotReport(),
      });
    }
    const action = prepared.value;
    const canonical = canonicalJson([
      'umibe-action-call-v1',
      action.call.actionId,
      action.call.actionVersion,
      action.call.params,
    ]);
    const callId = `call:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
    const metadata = canonicalJson([
      candidate.expectedEffects,
      candidate.cost,
      candidate.risk,
    ]);
    const existing = groups.get(callId);
    if (existing !== undefined && existing.canonical !== canonical) {
      return Object.freeze({
        outcome: 'failed',
        stage: 'preparation',
        candidateId: candidate.id,
        reason: 'invalid_result',
        issue: candidateContractIssue(
          new ContractError(
            'INVALID_CANDIDATES',
            'candidate_identity',
            `/candidates/${index}`,
            'call_identity_collision',
          ),
        ),
        request,
        providerSet,
        report: snapshotReport(),
      });
    }
    normalized += 1;
    if (existing === undefined) {
      groups.set(callId, {
        canonical,
        metadata,
        conflict: false,
        proposals: [{ index, candidate, action }],
      });
    } else {
      existing.proposals.push({ index, candidate, action });
      if (existing.metadata !== metadata) existing.conflict = true;
    }
  }

  const report = snapshotReport();
  const id = `candidates:${randomUUID()}`;
  const graph = request.context.graph;
  const pathContent = canonicalJson([
    'umibe-goal-path-v1',
    graph.runId,
    graph.goalPath.map((ref) => [ref.id, ref.version]),
  ]);
  const goalPathRef = `path:${createHash('sha256').update(pathContent, 'utf8').digest('hex')}`;
  const candidates: Candidate[] = [];
  const calls = new Map<string, PreparedAction>();
  for (const [callId, group] of groups) {
    if (group.conflict) continue;
    const first = group.proposals[0]!;
    const candidate: Candidate = Object.freeze({
      ...first.candidate,
      id: callId,
      candidateSetId: id,
      params: first.action.call.params,
      paramSources: first.action.call.paramSources,
      goalRef: graph.currentGoalRef,
      goalPathRef,
    });
    candidates.push(candidate);
    calls.set(callId, first.action);
  }
  const exclusionCounts = new Map<string, number>();
  for (const entry of report.entries) {
    if (entry.outcome !== 'excluded' || entry.reason === null) continue;
    exclusionCounts.set(
      entry.reason,
      (exclusionCounts.get(entry.reason) ?? 0) + 1,
    );
  }
  const exclusions: readonly CandidateExclusion[] = Object.freeze(
    [...exclusionCounts].map(([reason, count]) =>
      Object.freeze({ stage: 'checking', reason, count }),
    ),
  );
  const set: CandidateSet = Object.freeze({
    ...providerSet,
    id,
    rootGoalRef: graph.rootGoalRef,
    currentGoalRef: graph.currentGoalRef,
    goalPath: graph.goalPath,
    goalPathRef,
    coverage: Object.freeze({
      ...providerSet.coverage,
      checking:
        candidates.length > 0 ? 'partial' : providerSet.coverage.checking,
      uncheckedScopes: Object.freeze([
        ...providerSet.coverage.uncheckedScopes,
        ...candidates.map((candidate) => `core:candidate:${candidate.id}`),
      ]),
      // Provider exclusion counts may overlap its proposals; keep them only in
      // providerSet.coverage and report core exclusions independently here.
      exclusions,
    }),
    candidates: Object.freeze(candidates),
  });
  const stopped = control.signal.aborted
    ? 'cancelled'
    : Date.now() >= control.deadlineMs
      ? 'deadlineExceeded'
      : null;
  if (stopped !== null) {
    return Object.freeze({
      ...invocationFailure({ outcome: stopped }, 'preparation', null),
      request,
      providerSet,
      report,
    });
  }
  return Object.freeze({
    outcome: 'prepared',
    prepared: registerPreparedCandidates(
      { request, providerSet, set, report },
      calls,
    ),
  });
}
