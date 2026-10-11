import { randomUUID } from 'node:crypto';
import { ActionRegistry } from '#internal/action/registry';
import type {
  Agent,
  AgentOptions,
  RunHandle,
  StartRun,
} from '#internal/contracts/runtime';
import type { JsonValue } from '#internal/contracts/json';
import type { ChangeBatch } from '#internal/contracts/changes';
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
import { captureModelIdentity } from '#internal/model/validation';
import { RunSession } from './session.js';
import { RunDriver } from './runner.js';

const validation = { code: 'INVALID_RUN_CONTROL', stage: 'agent' } as const;

/**
 * Create an in-process runner with explicit adapters and store ownership.
 * All adapters perform bounded cooperative work; only registered execute callbacks
 * may change external business state. Resume and reconciliation explicitly acquire
 * stored runs; opening an agent never starts historical work.
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
    [input.environment?.observe, 'snapshot'],
    [input.verifier, 'support'],
    [input.verifier, 'verify'],
    [input.store, 'commit'],
  ] as const) {
    if (
      adapter == null ||
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
  const plannerModel =
    input.planner.model === undefined
      ? undefined
      : captureModelIdentity(input.planner.model);
  const selectorModel =
    input.selector.model === undefined
      ? undefined
      : captureModelIdentity(input.selector.model);
  if (
    input.selector.modelAccounting !== undefined &&
    (input.selector.modelAccounting !== 'perRequest' ||
      selectorModel === undefined)
  )
    throw new ContractError(
      validation.code,
      validation.stage,
      '/selector/modelAccounting',
      'invalid_model_accounting',
    );
  const options = Object.freeze({
    ...input,
    limits,
    // Capture identity once while preserving class adapter method receivers.
    planner:
      plannerModel === undefined
        ? input.planner
        : Object.freeze({
            model: plannerModel,
            plan: input.planner.plan.bind(input.planner),
          }),
    selector:
      selectorModel === undefined
        ? input.selector
        : Object.freeze({
            model: selectorModel,
            ...(input.selector.modelAccounting === undefined
              ? {}
              : { modelAccounting: input.selector.modelAccounting }),
            ...(input.selector.capacity === undefined
              ? {}
              : { capacity: input.selector.capacity }),
            select: input.selector.select.bind(input.selector),
          }),
    modelStages: Object.freeze(
      [
        ...new Set([
          ...(input.modelStages ?? []),
          ...(plannerModel === undefined ? [] : ['planning' as const]),
          ...(selectorModel === undefined ? [] : ['selection' as const]),
        ]),
      ].sort(),
    ),
  });
  const identity = Object.freeze({
    applicationId:
      options.applicationId === undefined
        ? null
        : requireString(options.applicationId, validation, '/applicationId'),
    actionVersions: registry.capabilities.map(({ id, version }) => ({
      id,
      version,
    })),
    modelStages: options.modelStages,
  });
  const runs = new Map<string, RunDriver<TCriteria>>();
  const starting = new Set<string>();
  let closed = false;
  let closing: Promise<void> | null = null;
  const subscriptions = new Map<string, () => void>();
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
  const subscribeEnvironment = (
    session: RunSession,
    publish: (batch: ChangeBatch) => Promise<void>,
  ) => {
    const source = options.environment.observe;
    if (source.changes === undefined) return;
    const runId = session.runId;
    if (
      ['cancelled', 'succeeded', 'failed'].includes(
        session.state.control.status,
      )
    )
      return;
    const lifecycle = new AbortController();
    const signal = AbortSignal.any([session.ownershipSignal, lifecycle.signal]);
    let active = true;
    let unsubscribe: () => void;
    try {
      unsubscribe = source.changes({ runId, signal }, async (input) => {
        try {
          if (!active || signal.aborted)
            throw new ContractError(
              validation.code,
              validation.stage,
              '/observation',
              'subscription_released',
            );
          // Session publication captures mutable source input before any awaits.
          await publish(input);
        } catch (error) {
          session.report('environment_event_failed', null);
          throw error;
        }
      });
      if (typeof unsubscribe !== 'function')
        throw new ContractError(
          validation.code,
          validation.stage,
          '/observe/changes',
          'missing_unsubscribe',
        );
    } catch (error) {
      active = false;
      lifecycle.abort();
      throw error;
    }
    const dispose = () => {
      if (!active) return;
      active = false;
      signal.removeEventListener('abort', dispose);
      lifecycle.abort();
      unwatch();
      subscriptions.delete(runId);
      try {
        unsubscribe();
      } catch {
        session.report('environment_subscription_failed', null);
      }
    };
    const unwatch = session.subscribe(() => {
      if (
        ['cancelled', 'succeeded', 'failed'].includes(
          session.committedState.control.status,
        )
      )
        dispose();
    });
    subscriptions.set(runId, dispose);
    signal.addEventListener('abort', dispose, { once: true });
    if (signal.aborted) dispose();
  };
  const load = async (input: string): Promise<RunDriver<TCriteria>> => {
    if (closed)
      throw new ContractError(
        validation.code,
        validation.stage,
        '',
        'agent_closed',
      );
    const runId = requireString(input, validation, '/runId');
    const existing = runs.get(runId);
    if (existing !== undefined) return existing;
    if (starting.has(runId))
      throw new ContractError(
        validation.code,
        validation.stage,
        '/runId',
        'run_owned',
      );
    starting.add(runId);
    try {
      const session = await RunSession.restore(
        options.store,
        runId,
        options.onDiagnostic ?? (() => undefined),
        identity,
      );
      try {
        subscribeEnvironment(
          session,
          (batch) =>
            runs.get(runId)?.publish(batch) ?? session.publishChanges(batch),
        );
        const driver = new RunDriver(session, registry, options);
        runs.set(runId, driver);
        return driver;
      } catch (error) {
        subscriptions.get(runId)?.();
        runs.delete(runId);
        await session.drain();
        await session.close();
        throw error;
      }
    } finally {
      starting.delete(runId);
    }
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
      let session: RunSession | undefined;
      try {
        session = await RunSession.create(
          options.store,
          {
            requestId: randomUUID(),
            decisionEpoch: 0,
            context: {
              graph,
              planRef: null,
              planGuidance: null,
              // This marker permits durable ingress before a source snapshot exists.
              // Session admission blocks all model and action work until initialization.
              observation: {
                runId,
                id: randomUUID(),
                revision: 0,
                observedAt: new Date().toISOString(),
                source: 'core:initialization',
                coverage: {
                  scope: 'initialization',
                  completeness: 'partial',
                  uncheckedScopes: ['environment'],
                },
                data: {},
              },
              constraintsVersion: 1,
              effectiveConstraints,
              applicationContext,
              lastActionResult: null,
              recentEvents: [],
            },
          },
          options.onDiagnostic ?? (() => undefined),
          limits,
          identity,
          true,
        );
        const created = session;
        subscribeEnvironment(
          session,
          (batch) =>
            runs.get(runId)?.publish(batch) ?? created.publishChanges(batch),
        );
        const observed = await invokeControlled(
          captureControl({
            signal: session.ownershipSignal,
            deadlineAt: new Date(
              Date.now() + limits.callbackTimeoutMs,
            ).toISOString(),
          }),
          (control) => options.environment.observe.snapshot(null, control),
        );
        if (observed.outcome !== 'returned')
          throw new ContractError(
            validation.code,
            validation.stage,
            '/observation',
            `initial_observation_${observed.outcome}`,
          );
        const observation = parseObservation(observed.value);
        if (observation.runId !== runId)
          throw new ContractError(
            validation.code,
            validation.stage,
            '/observation/runId',
            'cross_run_observation',
          );
        await session.commit(
          {
            ...session.state,
            observations: { ...session.state.observations, initialized: true },
            decision: {
              ...session.state.decision,
              context: { ...session.state.decision.context, observation },
            },
          },
          [
            session.event('observation_accepted', 'initial_observation', {
              observation: parseJsonValue(observation, 'observation'),
            }),
          ],
        );
        const driver = new RunDriver(session, registry, options);
        runs.set(runId, driver);
        await session.transition({ kind: 'start' });
        const handle = driver.handle();
        driver.start();
        return handle;
      } catch (error) {
        subscriptions.get(runId)?.();
        runs.delete(runId);
        if (session !== undefined) {
          await session.drain();
          await session.close();
        }
        throw error;
      } finally {
        starting.delete(runId);
      }
    },
    resume: async (runId: string, update: Parameters<Agent['resume']>[1]) =>
      (await load(runId)).resume(update),
    reconcile: async (runId: string) => (await load(runId)).reconcile(),
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
    async close(): Promise<void> {
      if (closing !== null) return closing;
      if (
        starting.size !== 0 ||
        [...runs.values()].some(
          ({ session, restoring, hasPendingEvents }) =>
            restoring ||
            hasPendingEvents ||
            session.hasExecution ||
            session.hasPendingCommits ||
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
      closed = true;
      closing = Promise.all(
        [...runs.values()].map((run) => run.session.close()),
      ).then(() => undefined);
      for (const dispose of [...subscriptions.values()]) dispose();
      runs.clear();
      await closing;
    },
  });
}
