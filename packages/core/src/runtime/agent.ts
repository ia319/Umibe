import { randomUUID } from 'node:crypto';
import { ActionRegistry } from '#internal/action/registry';
import type {
  Agent,
  AgentOptions,
  RunHandle,
  StartRun,
} from '#internal/contracts/runtime';
import type { JsonValue } from '#internal/contracts/json';
import { captureControl, invokeControlled } from '#internal/candidate/control';
import { ContractError } from '#internal/errors';
import {
  requireKeys,
  requireObject,
  requireString,
} from '#internal/validation/fields';
import { parseJsonValue } from '#internal/validation/json';
import { parseGoalGraph } from '#internal/validation/goal';
import { parseObservation } from '#internal/validation/observation';
import { parseApplicationEvent } from '#internal/validation/event';
import { captureLimits } from './limits.js';
import { RunSession } from './session.js';
import { RunDriver } from './runner.js';

const validation = { code: 'INVALID_RUN_CONTROL', stage: 'agent' } as const;

/**
 * Create an in-process runner with explicit adapters and store ownership.
 * All adapters perform bounded cooperative work; only registered execute callbacks
 * may change external business state. Existing stored runs require the owning instance.
 */
export function createAgent<TCriteria extends JsonValue>(
  input: AgentOptions<TCriteria>,
): Agent {
  const registry = new ActionRegistry(input.actions);
  const limits = captureLimits(input.limits ?? {});
  for (const [adapter, callback] of [
    [input.planner, 'plan'],
    [input.selector, 'select'],
    [input.candidateProvider, 'generate'],
    [input.environment, 'observe'],
    [input.verifier, 'support'],
    [input.verifier, 'verify'],
    [input.store, 'commit'],
  ] as const) {
    if (
      adapter === null ||
      typeof adapter !== 'object' ||
      typeof Reflect.get(adapter, callback) !== 'function'
    )
      throw new ContractError(
        validation.code,
        validation.stage,
        `/${callback}`,
        'missing_callback',
      );
  }
  if (
    input.modelStages?.some(
      (stage) =>
        !['planning', 'selection', 'candidates', 'verification'].includes(
          stage,
        ),
    )
  )
    throw new ContractError(
      validation.code,
      validation.stage,
      '/modelStages',
      'invalid_model_stage',
    );
  const options = Object.freeze({
    ...input,
    limits,
    modelStages: Object.freeze([...(input.modelStages ?? [])]),
  });
  const runs = new Map<string, RunDriver<TCriteria>>();
  const starting = new Set<string>();
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  const owned = (runId: string) => {
    if (closed)
      throw new ContractError(
        validation.code,
        validation.stage,
        '',
        'agent_closed',
      );
    const run = runs.get(runId);
    if (run === undefined)
      throw new ContractError(
        validation.code,
        validation.stage,
        '/runId',
        'run_not_owned',
      );
    return run;
  };
  return Object.freeze({
    async start(input: StartRun): Promise<RunHandle> {
      if (closed)
        throw new ContractError(
          validation.code,
          validation.stage,
          '',
          'agent_closed',
        );
      const raw = requireObject(
        parseJsonValue(input, validation.stage),
        validation,
        '',
      );
      requireKeys(
        raw,
        [
          'runId',
          'goal',
          'effectiveConstraints',
          ...(Object.hasOwn(raw, 'context') ? ['context'] : []),
        ],
        validation,
        '',
      );
      const runId = requireString(raw.runId, validation, '/runId');
      const goal = requireObject(raw.goal, validation, '/goal');
      requireKeys(
        goal,
        [
          'id',
          'version',
          'description',
          'criteria',
          'hardConstraints',
          'limits',
          'preferences',
        ],
        validation,
        '/goal',
      );
      const graph = parseGoalGraph({
        runId,
        rootGoalRef: { id: goal.id, version: goal.version },
        currentGoalRef: { id: goal.id, version: goal.version },
        goals: [
          {
            ...goal,
            kind: 'root',
            runId,
            parentGoalRef: null,
            acceptedPlanRef: null,
            lifecycle: 'inProgress',
            lastAssessment: null,
          },
        ],
      });
      const effectiveConstraints = requireObject(
        raw.effectiveConstraints,
        validation,
        '/effectiveConstraints',
      );
      const applicationContext =
        raw.context === undefined
          ? {}
          : requireObject(raw.context, validation, '/context');
      if (runs.has(runId) || starting.has(runId))
        throw new ContractError(
          validation.code,
          validation.stage,
          '/runId',
          'run_owned',
        );
      starting.add(runId);
      try {
        const observed = await invokeControlled(
          captureControl({
            signal: new AbortController().signal,
            deadlineAt: new Date(
              Date.now() + limits.callbackTimeoutMs,
            ).toISOString(),
          }),
          (control) => options.environment.observe(null, control),
        );
        if (observed.outcome !== 'returned')
          throw new ContractError(
            validation.code,
            validation.stage,
            '/observation',
            `initial_observation_${observed.outcome}`,
          );
        const observation = parseObservation(observed.value);
        const session = await RunSession.create(
          options.store,
          {
            requestId: randomUUID(),
            decisionEpoch: 0,
            context: {
              graph,
              planRef: null,
              planGuidance: null,
              observation,
              constraintsVersion: 1,
              effectiveConstraints,
              applicationContext,
              lastActionResult: null,
              recentEvents: [],
            },
          },
          options.onDiagnostic ?? (() => undefined),
          limits,
        );
        const driver = new RunDriver(session, registry, options);
        runs.set(runId, driver);
        await session.transition({ kind: 'start' });
        const handle = driver.handle();
        if (unsubscribe === undefined && options.environment.subscribe) {
          try {
            unsubscribe = options.environment.subscribe((input) => {
              try {
                const event = parseApplicationEvent(input);
                const target = runs.get(event.runId);
                if (target)
                  void target
                    .emit(event)
                    .catch(() =>
                      target.session.report(
                        'environment_event_failed',
                        event.eventId,
                      ),
                    );
              } catch {
                session.report('environment_event_failed', null);
              }
            });
          } catch {
            session.report('environment_subscription_failed', null);
          }
        }
        driver.start();
        return handle;
      } finally {
        starting.delete(runId);
      }
    },
    resume: (runId: string) => owned(runId).resume(),
    pause: (runId: string, reasonCode: string) =>
      owned(runId).stop('pause', reasonCode),
    cancel: (runId: string, reasonCode: string) =>
      owned(runId).stop('cancel', reasonCode),
    emit: (input: Parameters<Agent['emit']>[0]) => {
      const event = parseApplicationEvent(input);
      return owned(event.runId).emit(event);
    },
    inspect: options.store.readRun.bind(options.store),
    records: options.store.readRecords.bind(options.store),
    subscribe: (runId: string, listener: Parameters<Agent['subscribe']>[1]) =>
      owned(runId).session.subscribe(listener),
    close(): void {
      if (closed) return;
      if (
        starting.size !== 0 ||
        [...runs.values()].some(
          ({ session }) =>
            session.hasExecution ||
            (session.failure === null &&
              ['running', 'pausing', 'cancelling'].includes(
                session.state.control.status,
              )),
        )
      )
        throw new ContractError(
          validation.code,
          validation.stage,
          '',
          'agent_active',
        );
      for (const run of runs.values()) run.session.close();
      try {
        unsubscribe?.();
      } catch {
        runs
          .values()
          .next()
          .value?.session.report('environment_subscription_failed', null);
      }
      runs.clear();
      closed = true;
    },
  });
}
