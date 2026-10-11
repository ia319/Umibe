import { randomUUID } from 'node:crypto';
import type { ActionRegistry } from '#internal/action/registry';
import type {
  ActionCheck,
  PreparedAction,
  Reconciliation,
} from '#internal/contracts/action';
import type { CallControl } from '#internal/contracts/control';
import type { Environment } from '#internal/contracts/adapters';
import type { SelectedCandidate } from '#internal/contracts/candidate-processing';
import type { ActionIntent, ActionResult } from '#internal/contracts/record';
import type { JsonObject, JsonValue } from '#internal/contracts/json';
import type { CandidateGenerationInput } from '#internal/contracts/candidate-processing';
import { captureControl, invokeControlled } from '#internal/candidate/control';
import type { InvocationResult } from '#internal/candidate/control';
import { captureDecisionRequest } from '#internal/candidate/context';
import { getSelectedCall } from '#internal/candidate/handles';
import {
  candidateInvalidationReason,
  recheckCandidateWithInvocation,
} from '#internal/candidate/recheck';
import { canonicalJson } from '#internal/candidate/identity';
import { ContractError } from '#internal/errors';
import { requireObject, requireString } from '#internal/validation/fields';
import { isJsonArray, parseJsonValue } from '#internal/validation/json';
import { parseObservation } from '#internal/validation/observation';
import { parseActionCheck } from '#internal/validation/action-check';
import { readActionResult } from '#internal/validation/record';
import type { RunSession } from './session.js';
import type { RunCause } from './state.js';
import { captureObservation } from './observation.js';
import {
  captureCallback,
  captureCallbackResponse,
} from './callback-receipt.js';
import type { CapturedCallbackResponse } from './callback-receipt.js';
import { requestReview } from './scheduling.js';

/** Records later-plan authorization without rewriting the original intent or launch basis. */
export interface ExecutionContinuation {
  readonly executionId: string;
  readonly decisionRequestId: string;
  readonly decisionEventId: string;
  /** Adopted plan epoch; the execution snapshot retains its original launch epoch. */
  readonly decisionEpoch: number;
  readonly planRef: ActionIntent['planRef'];
  readonly authorizedAt: string;
}

export interface ExecutionSnapshot {
  readonly basis: CandidateGenerationInput;
  readonly retryMode: PreparedAction['retryMode'];
  readonly intent: ActionIntent;
  readonly decisionEpoch: number;
  readonly phase: 'prepared' | 'running' | ActionResult['outcome'];
  readonly result: ActionResult | null;
  readonly retries: number;
  readonly reconciliation: 'performed' | 'notPerformed' | null;
  readonly progress: JsonObject;
  readonly stopCause: RunCause | null;
  /** Latest later-plan authorization, retained as history after execution or recovery. */
  readonly continuation: ExecutionContinuation | null;
}

export type ActionStartResult =
  | {
      readonly outcome: 'started';
      readonly executionId: string;
      readonly completion: Promise<ActionResult>;
    }
  | { readonly outcome: 'notExecuted'; readonly reasonCode: string };

interface Attempt {
  readonly selected: SelectedCandidate | null;
  readonly basis: CandidateGenerationInput;
  readonly intent: ActionIntent;
  readonly release: () => void;
  dispatched: boolean;
  // Raw settlement closes continuation before result persistence and verification finish.
  responseReceived: boolean;
  result: ActionResult | null;
  stopCause: RunCause | null;
  progress: JsonObject;
  reconciled: boolean;
  stop: ((cause: RunCause) => void) | null;
}

const validation = {
  code: 'INVALID_RUN_CONTROL',
  stage: 'action_execution',
} as const;
const consumedSelections = new WeakSet<SelectedCandidate>();

/** Coordinates one fixed call at a time; it never chooses goals or marks them complete. */
export class ActionCoordinator {
  #attempt: Attempt | null = null;
  #reconciling = false;

  constructor(
    private readonly session: RunSession,
    private readonly registry: ActionRegistry,
    private readonly environment: Environment,
  ) {
    const execution = session.state.execution;
    if (execution?.result?.outcome === 'unknown')
      this.#attempt = {
        selected: null,
        basis: execution.basis,
        intent: execution.intent,
        release: session.claimExecution(),
        dispatched: true,
        responseReceived: true,
        result: execution.result,
        stopCause: execution.stopCause,
        progress: execution.result.progress,
        reconciled: false,
        stop: null,
      };
  }

  get active():
    (ExecutionSnapshot & { readonly phase: 'prepared' | 'running' }) | null {
    const execution = this.session.state.execution;
    return execution !== null &&
      this.session.hasExecution &&
      (execution.phase === 'prepared' || execution.phase === 'running')
      ? { ...execution, phase: execution.phase }
      : null;
  }

  /**
   * Intent admission consumes the selected token across all coordinators.
   * A denied recheck leaves the token reusable.
   * Live retries retain their selected token. Confirmed unperformed executions
   * recovered without that token require a freshly checked call with identical parameters.
   * No automatic retries occur. Unknown effects retain the session's execution
   * lease until a late result or reconciliation confirms a complete boundary.
   * A started result confirms dispatch, not success. Completion waits for result
   * persistence and stop settlement; a storage rejection does not prove that the
   * external action stopped. The completion remains observed until cleanup ends.
   */
  async start(
    selected: SelectedCandidate,
    retryOf: string | null = null,
  ): Promise<ActionStartResult> {
    const session = this.session;
    const call = getSelectedCall(selected);
    const epoch = selected.filtered.checked.prepared.request.decisionEpoch;
    if (!session.canDispatch(epoch))
      return { outcome: 'notExecuted', reasonCode: 'run_or_decision_inactive' };
    const release = session.claimExecution();
    let attempt: Attempt | null = null;
    try {
      let retries = 0;
      const prior = session.state.execution;
      if (prior?.reconciliation === 'notPerformed') {
        if (
          prior.intent.actionId !== call.call.actionId ||
          prior.intent.actionVersion !== call.call.actionVersion ||
          canonicalJson(prior.intent.params) !== canonicalJson(call.call.params)
        ) {
          await this.block('retry_call_changed');
          return { outcome: 'notExecuted', reasonCode: 'retry_call_changed' };
        }
        retryOf ??= prior.intent.executionId;
      }
      if (retryOf === null && consumedSelections.has(selected))
        throw new ContractError(
          validation.code,
          validation.stage,
          '/selected',
          'selection_already_used',
        );
      if (retryOf !== null) {
        const previous = session.state.execution;
        if (
          previous?.intent.executionId !== retryOf ||
          (previous.reconciliation !== 'notPerformed' &&
            this.#attempt?.selected !== selected) ||
          previous.result === null ||
          previous.result.outcome === 'unknown' ||
          previous.result.outcome === 'succeeded' ||
          previous.retries >= session.state.limits.actionRetries ||
          call.retryMode !== previous.retryMode ||
          previous.retryMode === 'never' ||
          (call.retryMode === 'reconcile' &&
            previous.reconciliation !== 'notPerformed')
        ) {
          throw new ContractError(
            validation.code,
            validation.stage,
            '/retryOf',
            'retry_not_allowed',
          );
        }
        retries = previous.retries + 1;
      }
      if (
        session.state.limits.maxActionAttempts !== null &&
        session.state.actionAttempts >= session.state.limits.maxActionAttempts
      ) {
        await this.block('action_budget_exhausted');
        return {
          outcome: 'notExecuted',
          reasonCode: 'action_budget_exhausted',
        };
      }
      const observationFailure = await this.refreshObservation(epoch);
      if (observationFailure !== null)
        return { outcome: 'notExecuted', reasonCode: observationFailure };
      const recheck = await recheckCandidateWithInvocation(
        selected,
        session.state.decision,
        this.registry,
        {
          signal: session.signal,
          deadlineAt: new Date(
            Date.now() + session.state.limits.callbackTimeoutMs,
          ).toISOString(),
        },
        (input, control, check) =>
          captureCallback(
            session,
            {
              stage: 'rechecking',
              phase: 'execution',
              decisionEpoch: epoch,
              input,
            },
            control,
            () => session.canDispatch(epoch),
            check,
          ),
      );
      if (
        recheck.outcome !== 'rechecked' ||
        recheck.check.outcome !== 'allowed'
      ) {
        const reasonCode =
          recheck.outcome === 'rechecked'
            ? recheck.check.outcome
            : recheck.reason;
        await session.commit(session.state, [
          session.event('action_not_executed', reasonCode, {
            candidateId: selected.candidate.id,
          }),
        ]);
        if (
          recheck.outcome === 'failed' ||
          recheck.outcome === 'deadlineExceeded'
        )
          await this.block(reasonCode);
        return { outcome: 'notExecuted', reasonCode };
      }
      if (!session.canDispatch(epoch))
        return {
          outcome: 'notExecuted',
          reasonCode: 'run_or_decision_inactive',
        };
      const context = recheck.request.context;
      if (context.planRef === null)
        throw new ContractError(
          validation.code,
          validation.stage,
          '/planRef',
          'missing_plan',
        );
      const intent: ActionIntent = Object.freeze({
        executionId: randomUUID(),
        decisionId: selected.selection.decisionId,
        candidateSetId: selected.filtered.set.id,
        candidateId: selected.candidate.id,
        actionId: call.call.actionId,
        actionVersion: call.call.actionVersion,
        params: call.call.params,
        rootGoalRef: context.graph.rootGoalRef,
        currentGoalRef: context.graph.currentGoalRef,
        goalPathRef: selected.candidate.goalPathRef,
        planRef: context.planRef,
        observationRef: {
          id: context.observation.id,
          revision: context.observation.revision,
        },
        constraintsVersion: context.constraintsVersion,
      });
      attempt = {
        selected,
        basis: recheck.request,
        intent,
        release,
        dispatched: false,
        responseReceived: false,
        result: null,
        stopCause: null,
        progress: {},
        reconciled: false,
        stop: null,
      };
      this.#attempt = attempt;
      consumedSelections.add(selected);
      await session.commit(
        {
          ...session.state,
          actionAttempts: session.state.actionAttempts + 1,
          execution: Object.freeze({
            basis: recheck.request,
            retryMode: call.retryMode,
            intent,
            decisionEpoch: epoch,
            phase: 'prepared',
            result: null,
            retries,
            reconciliation: null,
            progress: {},
            stopCause: null,
            continuation: null,
          }),
        },
        [
          {
            formatVersion: 1,
            runId: session.runId,
            eventId: randomUUID(),
            kind: 'actionIntent',
            data: intent,
          },
        ],
      );
      // No awaits are allowed between this live basis check and invoking execute.
      const stale = candidateInvalidationReason(
        selected,
        session.state.decision,
        this.registry.capabilities,
      );
      if (!session.canDispatch(epoch) || stale !== null) {
        const result: ActionResult = Object.freeze({
          executionId: intent.executionId,
          outcome: 'cancelled',
          reasonCode: stale ?? 'run_stopped_before_dispatch',
          underlyingSettled: true,
          confirmedEffects: {},
          unresolvedEffects: {},
          progress: {},
          stopCauseEventId: session.state.control.stopCause?.eventId ?? null,
        });
        attempt.result = result;
        await this.recordResult(attempt, result, true);
        return { outcome: 'notExecuted', reasonCode: result.reasonCode };
      }
      const running = session.state.execution!;
      const dispatchCommit = session.commit(
        {
          ...session.state,
          execution: Object.freeze({ ...running, phase: 'running' }),
        },
        [
          session.event('action_dispatched', 'execution_started', {
            executionId: intent.executionId,
            decisionId: intent.decisionId,
            decisionEpoch: epoch,
            retryOf,
          }),
        ],
      );
      const completion = this.runAction(attempt, call, dispatchCommit);
      // The caller may attach its completion continuation after dispatch settles.
      void completion.catch(() => undefined);
      return {
        outcome: 'started',
        executionId: intent.executionId,
        completion,
      };
    } finally {
      if (attempt === null || !attempt.dispatched) {
        release();
        if (session.failure === null)
          await this.settleStop(attempt?.result ?? null);
      }
    }
  }

  /**
   * Retain only a live call whose original goal path and hard constraints survive.
   * The proposed graph may focus another goal; plan references and guidance can
   * change without changing the fixed parameters or original execution ownership.
   */
  continuationInvalidationReason(
    executionId: string,
    input: CandidateGenerationInput,
  ): string | null {
    const attempt = this.#attempt;
    const execution = this.session.state.execution;
    if (!this.session.canDispatch(input.decisionEpoch))
      return 'run_or_decision_inactive';
    if (
      attempt === null ||
      attempt.intent.executionId !== executionId ||
      attempt.selected === null ||
      !attempt.dispatched ||
      attempt.responseReceived ||
      attempt.reconciled ||
      attempt.result !== null ||
      attempt.stopCause !== null ||
      !this.session.hasExecution ||
      execution?.intent.executionId !== executionId ||
      execution.phase !== 'running' ||
      execution.result !== null ||
      execution.stopCause !== null
    )
      return 'execution_changed';
    const original = attempt.selected.filtered.checked.prepared.request;
    const capability = this.registry.capabilities.find(
      (entry) => entry.id === attempt.intent.actionId,
    );
    if (capability === undefined) return 'action_unavailable';
    if (capability.version !== attempt.intent.actionVersion)
      return 'action_version_changed';
    if (
      capability !==
      original.capabilities.find((entry) => entry.id === capability.id)
    )
      return 'action_registration_changed';
    const previous = attempt.basis.context;
    const current = input.context;
    if (current.graph.runId !== previous.graph.runId) return 'run_changed';
    if (
      current.graph.rootGoalRef.id !== previous.graph.rootGoalRef.id ||
      current.graph.rootGoalRef.version !== previous.graph.rootGoalRef.version
    )
      return 'root_goal_changed';
    const currentGoals = new Map(
      current.graph.goals.map((goal) => [goal.id, goal]),
    );
    const previousGoals = new Map(
      previous.graph.goals.map((goal) => [goal.id, goal]),
    );
    for (const ref of previous.graph.goalPath) {
      const goal = currentGoals.get(ref.id);
      const prior = previousGoals.get(ref.id)!;
      if (goal === undefined || goal.version !== ref.version)
        return 'goal_path_changed';
      if (goal.lifecycle !== 'pending' && goal.lifecycle !== 'inProgress')
        return 'inactive_goal_path';
      // Plan adoption may update acceptedPlanRef while preserving the goal itself.
      if (
        goal.kind !== prior.kind ||
        goal.description !== prior.description ||
        canonicalJson(goal.criteria) !== canonicalJson(prior.criteria) ||
        JSON.stringify(goal.parentGoalRef) !==
          JSON.stringify(prior.parentGoalRef) ||
        (goal.kind === 'root' &&
          prior.kind === 'root' &&
          canonicalJson([
            goal.hardConstraints,
            goal.limits,
            goal.preferences,
          ]) !==
            canonicalJson([
              prior.hardConstraints,
              prior.limits,
              prior.preferences,
            ]))
      )
        return 'goal_definition_changed';
    }
    if (current.planRef === null) return 'plan_unavailable';
    if (
      current.constraintsVersion !== previous.constraintsVersion ||
      canonicalJson(current.effectiveConstraints) !==
        canonicalJson(previous.effectiveConstraints) ||
      canonicalJson(current.applicationContext ?? {}) !==
        canonicalJson(previous.applicationContext ?? {})
    )
      return 'constraints_changed';
    if (current.observation.revision < previous.observation.revision)
      return 'observation_regressed';
    if (
      current.observation.revision === previous.observation.revision &&
      canonicalJson(parseJsonValue(current.observation, validation.stage)) !==
        canonicalJson(parseJsonValue(previous.observation, validation.stage))
    )
      return 'observation_conflict';
    return null;
  }

  /**
   * Check the original fixed call against a proposed context focused on its goal.
   * Use the current review epoch before adoption. Cancellation bounds acceptance;
   * late callback receipts remain recorded. Success grants no continuation authority:
   * the caller must check live state again and commit authorization with the plan.
   * Invalid arguments and storage failures reject; callback failures return failed.
   */
  async checkContinuation(
    executionId: string,
    input: CandidateGenerationInput,
    controlInput: CallControl,
  ): Promise<
    | ActionCheck
    | { readonly outcome: 'stale' | 'failed'; readonly reason: string }
  > {
    const session = this.session;
    if (session.failure !== null) throw session.failure;
    const request = captureDecisionRequest(input);
    const supplied = captureControl(controlInput);
    const control = captureControl({
      ...supplied,
      signal: AbortSignal.any([
        supplied.signal,
        session.signal,
        session.ownershipSignal,
      ]),
      deadlineAt: new Date(
        Math.min(
          supplied.deadlineMs,
          Date.now() + session.state.limits.callbackTimeoutMs,
        ),
      ).toISOString(),
    });
    const reason = this.continuationInvalidationReason(executionId, request);
    if (reason !== null) return { outcome: 'stale', reason };
    const attempt = this.#attempt!;
    if (
      request.context.graph.currentGoalRef.id !==
        attempt.intent.currentGoalRef.id ||
      request.context.graph.currentGoalRef.version !==
        attempt.intent.currentGoalRef.version ||
      JSON.stringify(request.context.graph.goalPath) !==
        JSON.stringify(attempt.basis.context.graph.goalPath)
    )
      return { outcome: 'stale', reason: 'current_goal_changed' };
    const selected = attempt.selected!;
    const call = getSelectedCall(selected);
    const current = () =>
      this.#attempt === attempt &&
      this.continuationInvalidationReason(executionId, request) === null;
    let answer: InvocationResult<JsonValue>;
    try {
      answer = await captureCallback(
        session,
        {
          stage: 'rechecking',
          phase: 'continuation',
          decisionEpoch: request.decisionEpoch,
          input: {
            executionId,
            intent: attempt.intent,
            candidate: selected.candidate,
            call: call.call,
            basis: request,
          },
        },
        control,
        current,
        (callbackControl) => call.check(request.context, callbackControl),
      );
    } catch (error) {
      if (session.failure !== null) throw error;
      return { outcome: 'failed', reason: 'invalid_result' };
    }
    const stale = this.continuationInvalidationReason(executionId, request);
    if (this.#attempt !== attempt || stale !== null)
      return { outcome: 'stale', reason: stale ?? 'execution_changed' };
    if (answer.outcome !== 'returned')
      return {
        outcome: 'failed',
        reason:
          answer.outcome === 'failed'
            ? 'callback_failed'
            : answer.outcome === 'deadlineExceeded'
              ? 'deadline_exceeded'
              : 'cancelled',
      };
    if (control.signal.aborted || Date.now() >= control.deadlineMs)
      return {
        outcome: 'failed',
        reason: control.signal.aborted ? 'cancelled' : 'deadline_exceeded',
      };
    try {
      return parseActionCheck(answer.value);
    } catch {
      return { outcome: 'failed', reason: 'invalid_result' };
    }
  }

  /** A stale execution ID cannot interrupt the current action. */
  interrupt(executionId: string, cause: RunCause): boolean {
    if (
      this.#attempt?.intent.executionId !== executionId ||
      this.#attempt.stop === null
    )
      return false;
    this.#attempt.stop(cause);
    return true;
  }

  /** Explicit cleanup remains available for paused or cancelled runs; it never resumes them. */
  async reconcile(controlInput: CallControl): Promise<Reconciliation> {
    const attempt = this.#attempt;
    if (
      attempt === null ||
      attempt.result?.outcome !== 'unknown' ||
      this.session.state.execution?.result !== attempt.result ||
      this.#reconciling
    ) {
      throw new ContractError(
        validation.code,
        validation.stage,
        '/execution',
        'reconciliation_unavailable',
      );
    }
    if (this.session.failure !== null) throw this.session.failure;
    const checkpointExecution = this.session.checkpoint?.state.execution;
    if (
      typeof checkpointExecution !== 'object' ||
      checkpointExecution === null ||
      isJsonArray(checkpointExecution) ||
      checkpointExecution.phase !== 'unknown'
    )
      throw new ContractError(
        validation.code,
        validation.stage,
        '/execution',
        'reconciliation_unavailable',
      );
    const previous = attempt.result;
    const supplied = captureControl(controlInput);
    this.#reconciling = true;
    try {
      const answer = await this.invokeActionCallback(
        attempt,
        'action_reconciliation',
        { intent: parseJsonValue(attempt.intent, validation.stage) },
        captureControl({
          signal: AbortSignal.any([
            supplied.signal,
            this.session.ownershipSignal,
          ]),
          deadlineAt: new Date(
            Math.min(
              supplied.deadlineMs,
              Date.now() + this.session.state.limits.verificationTimeoutMs,
            ),
          ).toISOString(),
        }),
        () => attempt.result === previous && !attempt.reconciled,
        (control) => this.registry.reconcile(attempt.intent, control),
      );
      if (attempt.result !== previous)
        return { outcome: 'unknown', reason: 'execution_changed' };
      let reconciliation: Reconciliation;
      try {
        if (answer.outcome !== 'returned')
          reconciliation = { outcome: 'unknown', reason: answer.outcome };
        else if (answer.value.outcome === 'failed')
          reconciliation = { outcome: 'unknown', reason: 'failed' };
        else {
          if (answer.value.outcome === 'invalid') throw answer.value.error;
          reconciliation = this.captureReconciliation(
            attempt,
            answer.value.value,
          );
        }
      } catch {
        reconciliation = {
          outcome: 'unknown',
          reason: 'invalid_reconciliation',
        };
      }
      if (reconciliation.outcome === 'unknown') {
        await this.session.commit(this.session.state, [
          this.session.event('action_reconciled', 'effects_unknown', {
            executionId: attempt.intent.executionId,
            reason: reconciliation.reason,
          }),
        ]);
        return reconciliation;
      }
      const result: ActionResult =
        reconciliation.outcome === 'performed'
          ? reconciliation.result
          : Object.freeze({
              executionId: attempt.intent.executionId,
              outcome: 'failed',
              reasonCode: 'not_performed',
              underlyingSettled: true,
              confirmedEffects: {},
              unresolvedEffects: {},
              progress: {},
              stopCauseEventId:
                attempt.stopCause?.eventId ?? previous.stopCauseEventId,
            });
      attempt.reconciled = true;
      try {
        await this.recordResult(attempt, result, false, reconciliation.outcome);
      } finally {
        attempt.release();
      }
      await this.settleStop(result);
      return reconciliation;
    } finally {
      this.#reconciling = false;
    }
  }

  private async refreshObservation(epoch: number): Promise<string | null> {
    const session = this.session;
    const context = session.state.decision.context;
    const startedAt = Date.now();
    try {
      const result = await captureObservation(
        session,
        this.environment.observe,
        context,
        {
          signal: session.signal,
          deadlineAt: new Date(
            Date.now() + session.state.limits.callbackTimeoutMs,
          ).toISOString(),
        },
      );
      if (!session.canDispatch(epoch)) return 'run_or_decision_inactive';
      if (result.outcome !== 'returned') {
        await this.block(`observation_${result.outcome}`);
        return `observation_${result.outcome}`;
      }
      const observation = parseObservation(result.value);
      const latest = session.state.decision.context.observation;
      if (
        observation.runId !== session.runId ||
        observation.revision < latest.revision ||
        (observation.revision === latest.revision &&
          canonicalJson(parseJsonValue(observation, validation.stage)) !==
            canonicalJson(parseJsonValue(latest, validation.stage)))
      )
        throw new Error('Stale observation');
      const acceptedAt = Date.now();
      await session.replaceDecision(
        {
          ...session.state.decision,
          context: { ...session.state.decision.context, observation },
        },
        [
          session.event('observation_accepted', 'execution_observation', {
            observationRef: {
              id: observation.id,
              revision: observation.revision,
            },
            observedAt: observation.observedAt,
            acceptedAt: new Date(acceptedAt).toISOString(),
            observationLagMs: acceptedAt - Date.parse(observation.observedAt),
            durationMs: Math.max(0, Date.now() - startedAt),
          }),
        ],
      );
      return null;
    } catch (error) {
      if (session.failure !== null) throw error;
      await this.block('invalid_observation');
      return 'invalid_observation';
    }
  }

  private runAction(
    attempt: Attempt,
    call: PreparedAction,
    dispatchCommit: Promise<void>,
  ): Promise<ActionResult> {
    const session = this.session;
    const parent = session.signal;
    const controller = new AbortController();
    const deadlineAt = new Date(
      Date.now() + session.state.limits.actionTimeoutMs,
    ).toISOString();
    return new Promise<ActionResult>((resolve, reject) => {
      let finished = false;
      let observed: ActionResult | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const current = () =>
        this.#attempt === attempt &&
        !attempt.reconciled &&
        (attempt.result === null || attempt.result.outcome === 'unknown');
      // Storage failure closes dispatch immediately; cleanup still observes the action.
      void dispatchCommit.catch(reject);
      const cleanup = () => {
        clearTimeout(timer);
        if (grace !== undefined) clearTimeout(grace);
        parent.removeEventListener('abort', stopFromRun);
        attempt.stop = null;
      };
      const accept = async (result: ActionResult) => {
        if (finished) {
          if (attempt.reconciled || attempt.result?.outcome !== 'unknown')
            return;
          try {
            await this.recordResult(attempt, result);
          } finally {
            if (result.outcome !== 'unknown') attempt.release();
          }
          return;
        }
        finished = true;
        cleanup();
        attempt.result = result;
        try {
          await dispatchCommit;
          await this.recordResult(attempt, result);
          if (result.outcome === 'unknown')
            await this.block(
              result.underlyingSettled
                ? 'effects_unknown'
                : 'execution_unsettled',
            );
          resolve(result);
        } catch (error) {
          if (result.outcome !== 'unknown') attempt.release();
          reject(
            error instanceof Error
              ? error
              : new Error('Action result commit failed', { cause: error }),
          );
        }
      };
      const stop = (cause: RunCause) => {
        if (finished || attempt.stopCause !== null) return;
        attempt.stopCause = Object.freeze({
          eventId: requireString(cause.eventId, validation, '/eventId'),
          reasonCode: requireString(
            cause.reasonCode,
            validation,
            '/reasonCode',
          ),
        });
        if (session.failure === null)
          void session
            .commit(
              {
                ...session.state,
                execution:
                  session.state.execution?.intent.executionId ===
                  attempt.intent.executionId
                    ? {
                        ...session.state.execution,
                        stopCause: attempt.stopCause,
                      }
                    : session.state.execution,
                scheduling: requestReview(session.state.scheduling),
              },
              [
                session.event('action_stop_requested', cause.reasonCode, {
                  executionId: attempt.intent.executionId,
                  stopCauseEventId: cause.eventId,
                }),
              ],
            )
            .catch(() => undefined);
        controller.abort();
        grace = setTimeout(() => {
          void accept(
            this.unknownResult(attempt, cause.reasonCode, observed),
          ).catch(reject);
        }, session.state.limits.stopGraceMs);
      };
      const stopFromRun = () =>
        stop(
          session.state.control.stopCause ?? {
            eventId: randomUUID(),
            reasonCode: session.failure?.reason ?? 'run_stopped',
          },
        );
      const stopWithReason = (reasonCode: string) => {
        if (finished || attempt.stopCause !== null) return;
        const record = session.event('action_interrupted', reasonCode, {
          executionId: attempt.intent.executionId,
        });
        if (session.failure === null)
          void session.commit(session.state, [record]).catch(() => undefined);
        stop({ eventId: record.eventId, reasonCode });
      };
      const timer = setTimeout(
        () => stopWithReason('action_timeout'),
        session.state.limits.actionTimeoutMs,
      );
      attempt.stop = stop;
      parent.addEventListener('abort', stopFromRun, { once: true });
      attempt.dispatched = true;
      let returned: Promise<ActionResult>;
      try {
        returned = call.execute({
          executionId: attempt.intent.executionId,
          decision: session.state.decision.context,
          signal: controller.signal,
          deadlineAt,
          reportProgress: (progress) => {
            const receipt = this.captureActionReceipt(
              attempt,
              'action_progress',
              attempt.intent.executionId,
              { signal: controller.signal, deadlineAt },
              () => current() && !finished && !controller.signal.aborted,
              { outcome: 'returned', value: progress },
            );
            void receipt.committed
              .then(async () => {
                if (finished || controller.signal.aborted || attempt.reconciled)
                  return;
                try {
                  if (receipt.response.outcome !== 'returned')
                    throw receipt.response.error;
                  attempt.progress = requireObject(
                    receipt.response.value,
                    validation,
                    '/progress',
                  );
                } catch {
                  stopWithReason('invalid_action_progress');
                  return;
                }
                await session.commit(
                  {
                    ...session.state,
                    execution:
                      session.state.execution?.intent.executionId ===
                      attempt.intent.executionId
                        ? {
                            ...session.state.execution,
                            progress: attempt.progress,
                          }
                        : session.state.execution,
                    scheduling: requestReview(session.state.scheduling),
                  },
                  [
                    session.event('action_progress', 'progress_reported', {
                      executionId: attempt.intent.executionId,
                      progress: attempt.progress,
                    }),
                  ],
                );
              })
              .catch(() => undefined);
          },
        });
      } catch (error) {
        returned = Promise.reject(
          new Error('Action execution failed', { cause: error }),
        );
      }
      void Promise.resolve(returned)
        .then(
          async (raw) => {
            attempt.responseReceived = true;
            const receipt = this.captureActionReceipt(
              attempt,
              'action_execution',
              attempt.intent.executionId,
              { signal: controller.signal, deadlineAt },
              current,
              { outcome: 'returned', value: raw },
            );
            try {
              await receipt.committed;
            } catch (error) {
              finished = true;
              cleanup();
              if (call.verifyResult === undefined)
                this.releaseConfirmedReceipt(
                  attempt,
                  'action_execution',
                  receipt.response,
                );
              throw error;
            }
            if (attempt.reconciled) return;
            let result: ActionResult;
            try {
              if (receipt.response.outcome !== 'returned')
                throw receipt.response.error;
              result = this.captureResult(attempt, receipt.response.value);
              observed = result;
              if (call.verifyResult !== undefined) {
                const verificationInput = result;
                const verified = await this.invokeActionCallback(
                  attempt,
                  'action_verification',
                  {
                    intent: parseJsonValue(attempt.intent, validation.stage),
                    result: parseJsonValue(verificationInput, validation.stage),
                  },
                  captureControl({
                    signal: session.ownershipSignal,
                    deadlineAt: new Date(
                      Date.now() + session.state.limits.verificationTimeoutMs,
                    ).toISOString(),
                  }),
                  current,
                  (control) =>
                    call.verifyResult!(
                      attempt.intent,
                      verificationInput,
                      control,
                    ),
                );
                if (attempt.reconciled) return;
                if (
                  verified.outcome === 'returned' &&
                  verified.value.outcome === 'invalid'
                )
                  throw verified.value.error;
                result =
                  verified.outcome === 'returned' &&
                  verified.value.outcome === 'returned'
                    ? this.captureResult(attempt, verified.value.value)
                    : this.unknownResult(
                        attempt,
                        'result_verification_failed',
                        result,
                      );
              }
            } catch (error) {
              if (session.failure !== null) {
                finished = true;
                cleanup();
                throw error;
              }
              result = this.unknownResult(
                attempt,
                'invalid_action_result',
                observed,
              );
            }
            if (result.outcome === 'unknown') controller.abort();
            await accept(result);
          },
          async (error: unknown) => {
            attempt.responseReceived = true;
            const receipt = this.captureActionReceipt(
              attempt,
              'action_execution',
              attempt.intent.executionId,
              { signal: controller.signal, deadlineAt },
              current,
              { outcome: 'failed', error },
            );
            try {
              await receipt.committed;
            } catch (failure) {
              finished = true;
              cleanup();
              throw failure;
            }
            if (attempt.reconciled) return;
            controller.abort();
            await accept(this.unknownResult(attempt, 'execution_failed'));
          },
        )
        .catch(reject);
    }).finally(async () => {
      if (attempt.result !== null && attempt.result.outcome !== 'unknown')
        attempt.release();
      if (session.failure === null) await this.settleStop(attempt.result);
    });
  }

  private async invokeActionCallback(
    attempt: Attempt,
    phase: 'action_verification' | 'action_reconciliation',
    input: JsonObject,
    controlInput: CallControl,
    current: () => boolean,
    invoke: (control: CallControl) => Promise<unknown>,
  ): Promise<InvocationResult<CapturedCallbackResponse>> {
    const session = this.session;
    const control = captureControl(controlInput);
    const requestId = randomUUID();
    const startedAt = Date.now();
    const request = {
      requestId,
      executionId: attempt.intent.executionId,
      decisionId: attempt.intent.decisionId,
    };
    await session.commit(session.state, [
      session.event('callback_started', phase, {
        ...request,
        input: parseJsonValue(input, validation.stage),
      }),
    ]);
    const result: InvocationResult<CapturedCallbackResponse> =
      session.failure !== null || session.ownershipSignal.aborted || !current()
        ? { outcome: 'cancelled' }
        : await invokeControlled(control, async (callbackControl) => {
            let received:
              | { outcome: 'returned'; value: unknown }
              | { outcome: 'failed'; error: unknown };
            try {
              received = {
                outcome: 'returned',
                value: await invoke(callbackControl),
              };
            } catch (error) {
              received = { outcome: 'failed', error };
            }
            const receipt = this.captureActionReceipt(
              attempt,
              phase,
              requestId,
              callbackControl,
              current,
              received,
            );
            try {
              await receipt.committed;
            } catch (error) {
              this.releaseConfirmedReceipt(attempt, phase, receipt.response);
              throw error;
            }
            return receipt.response;
          });
    try {
      await session.commit(session.state, [
        session.event('callback_finished', phase, {
          ...request,
          outcome:
            result.outcome === 'returned'
              ? result.value.outcome
              : result.outcome,
          currentAtReceipt: current(),
          durationMs: Math.max(0, Date.now() - startedAt),
        }),
      ]);
    } catch (error) {
      if (result.outcome === 'returned')
        this.releaseConfirmedReceipt(attempt, phase, result.value);
      throw error;
    }
    return result;
  }

  private captureActionReceipt(
    attempt: Attempt,
    phase:
      | 'action_execution'
      | 'action_verification'
      | 'action_reconciliation'
      | 'action_progress',
    requestId: string,
    control: CallControl,
    current: () => boolean,
    received:
      | { readonly outcome: 'returned'; readonly value: unknown }
      | { readonly outcome: 'failed'; readonly error: unknown },
  ): {
    readonly response: CapturedCallbackResponse;
    readonly committed: Promise<void>;
  } {
    const session = this.session;
    const receivedAt = Date.now();
    const { response, details } = captureCallbackResponse(
      received,
      validation.stage,
    );
    const receipt = session.event('callback_received', phase, {
      requestId,
      executionId: attempt.intent.executionId,
      decisionId: attempt.intent.decisionId,
      receivedAt: new Date(receivedAt).toISOString(),
      currentAtReceipt: current(),
      cancelledAtReceipt: control.signal.aborted,
      deadlineExceededAtReceipt: receivedAt >= Date.parse(control.deadlineAt),
      ...details,
    });
    const committed = (async () => {
      try {
        await session.commit(session.state, [receipt]);
      } catch (error) {
        session.report('receipt_failed', receipt.eventId);
        throw error;
      }
    })();
    return { response, committed };
  }

  private releaseConfirmedReceipt(
    attempt: Attempt,
    phase: 'action_execution' | 'action_verification' | 'action_reconciliation',
    response: CapturedCallbackResponse,
  ): void {
    if (attempt.reconciled || response.outcome !== 'returned') return;
    // Failed storage cannot accept new state, but a confirmed late boundary
    // still releases the lease held for the external effect.
    try {
      const boundary =
        phase === 'action_reconciliation'
          ? this.captureReconciliation(attempt, response.value)
          : this.captureResult(attempt, response.value);
      if (boundary.outcome !== 'unknown') attempt.release();
    } catch {
      // An invalid result cannot confirm that the effect has settled.
    }
  }

  private captureReconciliation(
    attempt: Attempt,
    raw: JsonValue,
  ): Reconciliation {
    const value = requireObject(raw, validation, '/reconciliation');
    if (value.outcome === 'unknown')
      return {
        outcome: 'unknown',
        reason: requireString(value.reason, validation, '/reason'),
      };
    if (value.outcome === 'notPerformed' && value.underlyingSettled === true)
      return {
        outcome: 'notPerformed',
        underlyingSettled: true,
        reason: requireString(value.reason, validation, '/reason'),
      };
    if (value.outcome === 'performed' && value.underlyingSettled === true) {
      const result = this.captureResult(attempt, value.result);
      if (result.outcome === 'unknown')
        throw new Error('Unconfirmed reconciliation');
      return { outcome: 'performed', underlyingSettled: true, result };
    }
    throw new Error('Invalid reconciliation');
  }

  private captureResult(attempt: Attempt, value: unknown): ActionResult {
    const result = readActionResult(
      parseJsonValue(value, validation.stage),
      validation,
      '/result',
    );
    if (result.executionId !== attempt.intent.executionId)
      throw new ContractError(
        validation.code,
        validation.stage,
        '/executionId',
        'execution_mismatch',
      );
    return Object.freeze({
      ...result,
      stopCauseEventId: attempt.stopCause?.eventId ?? result.stopCauseEventId,
    });
  }

  private unknownResult(
    attempt: Attempt,
    reasonCode: string,
    known?: ActionResult,
  ): ActionResult {
    return Object.freeze({
      executionId: attempt.intent.executionId,
      outcome: 'unknown',
      reasonCode: attempt.stopCause?.reasonCode ?? reasonCode,
      underlyingSettled: known?.underlyingSettled ?? false,
      confirmedEffects: known?.confirmedEffects ?? {},
      unresolvedEffects: { ...known?.unresolvedEffects, execution: reasonCode },
      progress: known?.progress ?? attempt.progress,
      stopCauseEventId:
        attempt.stopCause?.eventId ?? known?.stopCauseEventId ?? null,
    });
  }

  private async recordResult(
    attempt: Attempt,
    result: ActionResult,
    unsent = false,
    reconciliation: 'performed' | 'notPerformed' | null = null,
  ): Promise<void> {
    const session = this.session;
    attempt.result = result;
    const current = session.state.execution;
    const matches = current?.intent.executionId === attempt.intent.executionId;
    await session.commit(
      {
        ...session.state,
        actionAttempts: session.state.actionAttempts - (unsent ? 1 : 0),
        scheduling: requestReview(session.state.scheduling),
        // Persist the attempt before observation or verification can pause the run.
        progressAttempt:
          matches &&
          attempt.dispatched &&
          result.outcome !== 'unknown' &&
          ['running', 'pausing', 'paused'].includes(
            session.state.control.status,
          )
            ? {
                executionId: result.executionId,
                before: attempt.basis.context.graph,
                failed: result.outcome === 'failed',
              }
            : session.state.progressAttempt,
        recentResults: Object.freeze(
          [
            ...session.state.recentResults.filter(
              (item) => item.executionId !== result.executionId,
            ),
            result,
          ].slice(-50),
        ),
        execution: matches
          ? Object.freeze({
              ...current,
              phase: result.outcome,
              result,
              progress: result.progress,
              stopCause: attempt.stopCause,
              // A confirmed unsent reservation refunds this retry, not the
              // ancestry of the original uncertain execution.
              retries:
                unsent && current.retries > 0
                  ? current.retries - 1
                  : current.retries,
              reconciliation:
                unsent && current.retries > 0 ? 'notPerformed' : reconciliation,
            })
          : current,
        decision: matches
          ? Object.freeze({
              ...session.state.decision,
              context: Object.freeze({
                ...session.state.decision.context,
                lastActionResult: result,
              }),
            })
          : session.state.decision,
      },
      [
        {
          formatVersion: 1,
          runId: session.runId,
          eventId: randomUUID(),
          kind: 'actionResult',
          data: result,
        },
      ],
    );
  }

  private async block(reasonCode: string): Promise<void> {
    const session = this.session;
    if (session.state.control.status !== 'running') return;
    const record = session.event('run_blocked', reasonCode, {});
    await session.transition(
      {
        kind: 'pause',
        cause: { eventId: record.eventId, reasonCode },
      },
      [record],
    );
  }

  private async settleStop(result: ActionResult | null): Promise<void> {
    const session = this.session;
    if (
      session.state.control.status !== 'pausing' &&
      session.state.control.status !== 'cancelling'
    )
      return;
    const cause = session.state.control.stopCause!;
    const blocker =
      result?.outcome === 'unknown'
        ? {
            eventId: result.stopCauseEventId ?? cause.eventId,
            reasonCode: result.underlyingSettled
              ? 'effects_unknown'
              : 'execution_unsettled',
          }
        : session.state.control.status === 'pausing'
          ? cause
          : null;
    await session.transition({ kind: 'stopSettled', blocker });
  }
}
