import { randomUUID } from 'node:crypto';
import type { ActionRegistry } from '#internal/action/registry';
import type {
  PreparedAction,
  Reconciliation,
} from '#internal/contracts/action';
import type { CallControl, Environment } from '#internal/contracts/adapters';
import type { SelectedCandidate } from '#internal/contracts/candidate-processing';
import type { ActionIntent, ActionResult } from '#internal/contracts/record';
import type { JsonObject } from '#internal/contracts/json';
import { captureControl, invokeControlled } from '#internal/candidate/control';
import { getSelectedCall } from '#internal/candidate/handles';
import {
  candidateInvalidationReason,
  recheckCandidate,
} from '#internal/candidate/recheck';
import { canonicalJson } from '#internal/candidate/identity';
import { ContractError } from '#internal/errors';
import { requireObject, requireString } from '#internal/validation/fields';
import { isJsonArray, parseJsonValue } from '#internal/validation/json';
import { parseObservation } from '#internal/validation/observation';
import { readActionResult } from '#internal/validation/record';
import type { RunSession } from './session.js';
import type { RunCause } from './state.js';

export interface ExecutionSnapshot {
  readonly intent: ActionIntent;
  readonly decisionEpoch: number;
  readonly phase: 'prepared' | 'running' | ActionResult['outcome'];
  readonly result: ActionResult | null;
  readonly retries: number;
  readonly reconciliation: 'performed' | 'notPerformed' | null;
}

export type ActionDispatchResult =
  | { readonly outcome: 'recorded'; readonly result: ActionResult }
  | { readonly outcome: 'notExecuted'; readonly reasonCode: string };

interface Attempt {
  readonly selected: SelectedCandidate;
  readonly call: PreparedAction;
  readonly intent: ActionIntent;
  readonly release: () => void;
  dispatched: boolean;
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

/** Coordinates one fixed call at a time; it never chooses goals or marks them complete. */
export class ActionCoordinator {
  #attempt: Attempt | null = null;
  #reconciling = false;

  constructor(
    private readonly session: RunSession,
    private readonly registry: ActionRegistry,
    private readonly environment: Environment,
  ) {}

  /**
   * A retry must name the last execution and retain its exact selected token.
   * No automatic retries occur. Unknown effects retain the session's execution
   * lease until a late result or reconciliation confirms a complete boundary.
   */
  async execute(
    selected: SelectedCandidate,
    retryOf: string | null = null,
  ): Promise<ActionDispatchResult> {
    const session = this.session;
    const call = getSelectedCall(selected);
    const epoch = selected.filtered.checked.prepared.request.decisionEpoch;
    if (!session.canDispatch(epoch))
      return { outcome: 'notExecuted', reasonCode: 'run_or_decision_inactive' };
    let retries = 0;
    if (retryOf === null && this.#attempt?.selected === selected)
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
        this.#attempt?.selected !== selected ||
        previous.result === null ||
        previous.result.outcome === 'unknown' ||
        previous.result.outcome === 'succeeded' ||
        previous.retries >= session.state.limits.actionRetries ||
        call.retryMode === 'never' ||
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
    const release = session.claimExecution();
    let attempt: Attempt | null = null;
    try {
      if (
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
      const recheck = await recheckCandidate(
        selected,
        session.state.decision,
        this.registry,
        {
          signal: session.signal,
          deadlineAt: new Date(
            Date.now() + session.state.limits.callbackTimeoutMs,
          ).toISOString(),
        },
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
        call,
        intent,
        release,
        dispatched: false,
        result: null,
        stopCause: null,
        progress: {},
        reconciled: false,
        stop: null,
      };
      this.#attempt = attempt;
      await session.commit(
        {
          ...session.state,
          actionAttempts: session.state.actionAttempts + 1,
          execution: Object.freeze({
            intent,
            decisionEpoch: epoch,
            phase: 'prepared',
            result: null,
            retries,
            reconciliation: null,
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
      const result = await this.runAction(attempt, dispatchCommit);
      if (result.outcome !== 'unknown' && session.canDispatch(epoch))
        await this.refreshObservation(epoch);
      return { outcome: 'recorded', result };
    } finally {
      if (
        attempt === null ||
        !attempt.dispatched ||
        (attempt.result !== null && attempt.result.outcome !== 'unknown')
      )
        release();
      if (session.failure === null)
        await this.settleStop(attempt?.result ?? null);
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
      attempt.call.reconcile === undefined ||
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
      const answer = await invokeControlled(
        captureControl({
          signal: supplied.signal,
          deadlineAt: new Date(
            Math.min(
              supplied.deadlineMs,
              Date.now() + this.session.state.limits.verificationTimeoutMs,
            ),
          ).toISOString(),
        }),
        (control) => attempt.call.reconcile!(attempt.intent, control),
      );
      if (attempt.result !== previous)
        return { outcome: 'unknown', reason: 'execution_changed' };
      let reconciliation: Reconciliation;
      try {
        if (answer.outcome !== 'returned')
          return { outcome: 'unknown', reason: answer.outcome };
        const value = requireObject(
          parseJsonValue(answer.value, validation.stage),
          validation,
          '/reconciliation',
        );
        if (value.outcome === 'unknown')
          reconciliation = {
            outcome: 'unknown',
            reason: requireString(value.reason, validation, '/reason'),
          };
        else if (
          value.outcome === 'notPerformed' &&
          value.underlyingSettled === true
        )
          reconciliation = {
            outcome: 'notPerformed',
            underlyingSettled: true,
            reason: requireString(value.reason, validation, '/reason'),
          };
        else if (
          value.outcome === 'performed' &&
          value.underlyingSettled === true
        ) {
          const result = this.captureResult(attempt, value.result);
          if (result.outcome === 'unknown')
            throw new Error('Unconfirmed reconciliation');
          reconciliation = {
            outcome: 'performed',
            underlyingSettled: true,
            result,
          };
        } else throw new Error('Invalid reconciliation');
      } catch {
        return { outcome: 'unknown', reason: 'invalid_reconciliation' };
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
    const result = await invokeControlled(
      captureControl({
        signal: session.signal,
        deadlineAt: new Date(
          Date.now() + session.state.limits.callbackTimeoutMs,
        ).toISOString(),
      }),
      (control) => this.environment.observe(context, control),
    );
    if (!session.canDispatch(epoch)) return 'run_or_decision_inactive';
    if (result.outcome !== 'returned') {
      await this.block(`observation_${result.outcome}`);
      return `observation_${result.outcome}`;
    }
    try {
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
      await session.replaceDecision({
        ...session.state.decision,
        context: { ...session.state.decision.context, observation },
      });
      return null;
    } catch (error) {
      if (session.failure !== null) throw error;
      await this.block('invalid_observation');
      return 'invalid_observation';
    }
  }

  private runAction(
    attempt: Attempt,
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
            .commit(session.state, [
              session.event('action_stop_requested', cause.reasonCode, {
                executionId: attempt.intent.executionId,
                stopCauseEventId: cause.eventId,
              }),
            ])
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
        returned = attempt.call.execute({
          executionId: attempt.intent.executionId,
          decision: session.state.decision.context,
          signal: controller.signal,
          deadlineAt,
          reportProgress: (progress) => {
            if (finished || controller.signal.aborted) return;
            try {
              attempt.progress = requireObject(
                parseJsonValue(progress, validation.stage),
                validation,
                '/progress',
              );
            } catch {
              stopWithReason('invalid_action_progress');
              return;
            }
            void session
              .commit(session.state, [
                session.event('action_progress', 'progress_reported', {
                  executionId: attempt.intent.executionId,
                  progress: attempt.progress,
                }),
              ])
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
            if (attempt.reconciled) return;
            let result: ActionResult;
            try {
              result = this.captureResult(attempt, raw);
              observed = result;
              if (attempt.call.verifyResult !== undefined) {
                const verified = await invokeControlled(
                  captureControl({
                    signal: new AbortController().signal,
                    deadlineAt: new Date(
                      Date.now() + session.state.limits.verificationTimeoutMs,
                    ).toISOString(),
                  }),
                  (control) =>
                    attempt.call.verifyResult!(attempt.intent, result, control),
                );
                result =
                  verified.outcome === 'returned'
                    ? this.captureResult(attempt, verified.value)
                    : this.unknownResult(
                        attempt,
                        'result_verification_failed',
                        result,
                      );
              }
            } catch {
              result = this.unknownResult(
                attempt,
                'invalid_action_result',
                observed,
              );
            }
            if (result.outcome === 'unknown') controller.abort();
            await accept(result);
          },
          async () => {
            controller.abort();
            await accept(this.unknownResult(attempt, 'execution_failed'));
          },
        )
        .catch(reject);
    });
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
        execution: matches
          ? Object.freeze({
              ...current,
              phase: result.outcome,
              result,
              reconciliation,
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
    await session.transition({
      kind: 'pause',
      cause: { eventId: record.eventId, reasonCode },
    });
    await session.commit(session.state, [record]);
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
