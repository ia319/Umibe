import { randomUUID } from 'node:crypto';
import type { CandidateGenerationInput } from '#internal/contracts/candidate-processing';
import type {
  DecisionOption,
  DecisionRequest,
} from '#internal/contracts/decision';
import type { GoalGraphSnapshot } from '#internal/contracts/goal';
import type { PlanRef } from '#internal/contracts/references';
import type { PendingPlanProposal } from '#internal/planner/contracts';
import type { RunRecordDraft } from '#internal/storage/contracts';
import { captureDecisionRequest } from '#internal/candidate/context';
import { canonicalJson } from '#internal/candidate/identity';
import { parseJsonValue } from '#internal/validation/json';
import type { ActionCoordinator } from './execution.js';
import type { GoalState } from './goals.js';
import type { SelectionLifecycle } from './selection-lifecycle.js';
import type { PendingPlanAdoption, RunSession } from './session.js';
import { requestReview } from './scheduling.js';

export interface PreparedPlan {
  readonly graph: GoalGraphSnapshot;
  readonly planRef: PlanRef;
  readonly guidance: string | null;
  readonly goals: GoalState;
  readonly records: readonly RunRecordDraft[];
}

type DecisionAcceptance =
  | {
      readonly outcome: 'accepted';
      readonly decisionEventId: string;
      readonly decisionEpoch: number;
      readonly pendingAdoption: PendingPlanAdoption | null;
    }
  | { readonly outcome: 'rejected' };

export function proposalApplies(
  session: RunSession,
  pending: PendingPlanProposal,
): boolean {
  const previous = pending.request.context;
  const current = session.state.decision.context;
  return (
    canonicalJson(
      parseJsonValue(
        {
          root: previous.graph.rootGoalRef,
          current: previous.graph.currentGoalRef,
          path: previous.graph.goalPath,
          plan: previous.planRef,
          constraintsVersion: previous.constraintsVersion,
          constraints: previous.effectiveConstraints,
          applicationContext: previous.applicationContext ?? {},
        },
        'planning',
      ),
    ) ===
    canonicalJson(
      parseJsonValue(
        {
          root: current.graph.rootGoalRef,
          current: current.graph.currentGoalRef,
          path: current.graph.goalPath,
          plan: current.planRef,
          constraintsVersion: current.constraintsVersion,
          constraints: current.effectiveConstraints,
          applicationContext: current.applicationContext ?? {},
        },
        'planning',
      ),
    )
  );
}

export function decisionApplies(
  session: RunSession,
  request: DecisionRequest,
  execution: ActionCoordinator,
  selection: SelectionLifecycle,
): boolean {
  const state = session.state;
  const basis = request.basis;
  const context = state.decision.context;
  const active = execution.active;
  return (
    session.canDispatch(basis.decisionEpoch) &&
    basis.executionId === (active?.intent.executionId ?? null) &&
    active?.stopCause == null &&
    basis.selectionId === (selection.snapshot()?.summary.selectionId ?? null) &&
    basis.proposalId === (state.pendingProposal?.proposalId ?? null) &&
    basis.constraintsVersion === context.constraintsVersion &&
    canonicalJson(
      parseJsonValue(
        [
          basis.rootGoalRef,
          basis.currentGoalRef,
          basis.goalPath,
          basis.planRef,
        ],
        'decision',
      ),
    ) ===
      canonicalJson(
        parseJsonValue(
          [
            context.graph.rootGoalRef,
            context.graph.currentGoalRef,
            context.graph.goalPath,
            context.planRef,
          ],
          'decision',
        ),
      )
  );
}

export function rejectDecision(
  session: RunSession,
  request: DecisionRequest,
  reasonCode: string,
  optionId: string | null,
): Promise<void> {
  if (session.failure !== null) return Promise.resolve();
  return session.commit(
    { ...session.state, scheduling: requestReview(session.state.scheduling) },
    [
      session.event('decision_rejected', reasonCode, {
        requestId: request.requestId,
        optionId,
      }),
    ],
  );
}

/**
 * Call after validating the option against its request and completing async plan
 * preparation and any continuation check. Final guards and admission share one turn.
 */
export async function acceptDecision(
  session: RunSession,
  execution: ActionCoordinator,
  selection: SelectionLifecycle,
  input: {
    readonly request: DecisionRequest;
    readonly option: DecisionOption;
    readonly prepared: PreparedPlan | null;
    readonly continuationBasis: CandidateGenerationInput | null;
  },
): Promise<DecisionAcceptance> {
  const { request, option, prepared, continuationBasis } = input;
  if (!decisionApplies(session, request, execution, selection)) {
    await rejectDecision(session, request, 'basis_changed', option.id);
    return { outcome: 'rejected' };
  }
  const chosen = option.decision;
  if (
    continuationBasis !== null &&
    chosen.kind === 'adoptPlan' &&
    chosen.execution.kind === 'keep' &&
    execution.continuationInvalidationReason(
      chosen.execution.executionId,
      continuationBasis,
    ) !== null
  ) {
    await rejectDecision(session, request, 'continuation_stale', option.id);
    return { outcome: 'rejected' };
  }
  const state = session.state;
  const pending = state.pendingProposal;
  const selected = selection.snapshot()?.summary ?? null;
  const { throughSequence, reviewVersion } = request.basis;
  const unreadChanges = state.observations.unreadChanges.filter(
    (change) => change.sequence > throughSequence,
  );
  const discard =
    chosen.kind !== 'adoptPlan' && chosen.proposal?.kind === 'discard';
  let scheduling = {
    ...state.scheduling,
    reviewPending:
      state.scheduling.reviewVersion !== reviewVersion ||
      unreadChanges.length > 0,
  };
  if (prepared !== null) scheduling = requestReview(scheduling);
  const accepted = session.event('decision_accepted', chosen.kind, {
    requestId: request.requestId,
    optionId: option.id,
    decision: parseJsonValue(chosen, 'decision'),
    throughSequence,
  });
  const stopAdoption =
    chosen.kind === 'adoptPlan' && chosen.execution.kind === 'stop';
  const adoptedDecision =
    prepared === null ? null : mergePlanDecision(state.decision, prepared);
  const continuation =
    chosen.kind === 'adoptPlan' &&
    chosen.execution.kind === 'keep' &&
    adoptedDecision !== null &&
    prepared !== null
      ? {
          executionId: chosen.execution.executionId,
          decisionRequestId: request.requestId,
          decisionEventId: accepted.eventId,
          decisionEpoch: adoptedDecision.decisionEpoch,
          planRef: prepared.planRef,
          authorizedAt: new Date().toISOString(),
        }
      : null;
  // Return this authorization after persistence even if a direct control clears live state.
  const pendingAdoption: PendingPlanAdoption | null =
    chosen.kind === 'adoptPlan' && chosen.execution.kind === 'stop'
      ? {
          proposalId: chosen.proposalId,
          executionId: chosen.execution.executionId,
          decisionRequestId: request.requestId,
          decisionEventId: accepted.eventId,
          basis: request.basis,
          acceptedAt: new Date().toISOString(),
        }
      : null;
  await session.commit(
    {
      ...state,
      ...(prepared === null || adoptedDecision === null
        ? {}
        : { decision: adoptedDecision, goals: prepared.goals }),
      execution:
        continuation !== null && state.execution !== null
          ? { ...state.execution, continuation }
          : state.execution,
      pendingProposal:
        (chosen.kind === 'adoptPlan' && !stopAdoption) || discard
          ? null
          : state.pendingProposal,
      pendingAdoption: pendingAdoption ?? state.pendingAdoption,
      observations: {
        ...state.observations,
        lastReviewedEventSequence: throughSequence,
        unreadChanges,
      },
      scheduling,
    },
    [
      accepted,
      ...(prepared?.records ?? []),
      ...(continuation === null
        ? []
        : [
            session.event('execution_continued', 'plan_adopted', {
              ...continuation,
              planRef: { ...continuation.planRef },
            }),
          ]),
      ...(selected !== null &&
      (chosen.kind === 'adoptPlan' || chosen.kind === 'selectOperation')
        ? [
            session.event('selection_discarded', chosen.kind, {
              selectionId: selected.selectionId,
            }),
          ]
        : []),
      ...(discard && pending !== null
        ? [
            session.event('proposal_discarded', 'decision_discard', {
              proposalId: pending.proposalId,
              requestId: request.requestId,
              optionId: option.id,
            }),
          ]
        : []),
    ],
  );
  return {
    outcome: 'accepted',
    decisionEventId: accepted.eventId,
    decisionEpoch:
      adoptedDecision?.decisionEpoch ?? state.decision.decisionEpoch,
    pendingAdoption,
  };
}

/** Check saved authorization; the original execution and selection may already have settled. */
export function stopAdoptionApplies(
  session: RunSession,
  authorization: PendingPlanAdoption,
): boolean {
  const pending = session.state.pendingProposal;
  return (
    session.canDispatch(authorization.basis.decisionEpoch) &&
    session.state.pendingAdoption?.decisionEventId ===
      authorization.decisionEventId &&
    pending !== null &&
    pending.proposalId === authorization.proposalId &&
    proposalApplies(session, pending)
  );
}

/**
 * Call after confirmed execution settlement and plan preparation.
 * Revalidate the captured authorization and admit the plan without an intervening await.
 */
export async function acceptStoppedPlan(
  session: RunSession,
  authorization: PendingPlanAdoption,
  prepared: PreparedPlan | null,
): Promise<
  | { readonly outcome: 'accepted'; readonly decisionEpoch: number }
  | { readonly outcome: 'rejected' }
> {
  if (!stopAdoptionApplies(session, authorization))
    return { outcome: 'rejected' };
  const state = session.state;
  const decision =
    prepared === null
      ? state.decision
      : mergePlanDecision(state.decision, prepared);
  await session.commit(
    {
      ...state,
      decision,
      goals: prepared?.goals ?? state.goals,
      pendingProposal: null,
      pendingAdoption: null,
      scheduling: requestReview(state.scheduling),
    },
    [
      ...(prepared?.records ?? []),
      session.event('plan_adoption_completed', 'execution_stopped', {
        proposalId: authorization.proposalId,
        executionId: authorization.executionId,
        decisionRequestId: authorization.decisionRequestId,
        decisionEventId: authorization.decisionEventId,
      }),
    ],
  );
  return { outcome: 'accepted', decisionEpoch: decision.decisionEpoch };
}

/** Merge prepared goals with facts received while support or continuation checks awaited. */
function mergePlanDecision(
  current: CandidateGenerationInput,
  prepared: PreparedPlan,
): CandidateGenerationInput {
  return captureDecisionRequest({
    requestId: randomUUID(),
    decisionEpoch: current.decisionEpoch + 1,
    context: {
      ...current.context,
      graph: prepared.graph,
      planRef: prepared.planRef,
      planGuidance: prepared.guidance,
    },
  });
}
