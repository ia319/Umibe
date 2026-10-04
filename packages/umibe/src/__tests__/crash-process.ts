import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SqliteRunStore } from '@umibe/storage-sqlite';
import { createAgent, defineAction } from 'umibe';
import type { ActionResult, ApplicationEvent, RunHandle } from 'umibe';
import type { CrashConfig, CrashReply } from './crash-host.js';

// Both the command and effect records are generated exclusively by this fixture.
const config = JSON.parse(process.argv[2]!) as CrashConfig;
const effectSchema = z.strictObject({
  executionId: z.string(),
  depth: z.number(),
  goal: z.string(),
  parameter: z.number(),
});
const effectPath = join(config.directory, 'effects.jsonl');
const auditPath = join(config.directory, 'reconciliations.jsonl');
function effects() {
  return existsSync(effectPath)
    ? readFileSync(effectPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => effectSchema.parse(JSON.parse(line)))
    : [];
}

async function stopAt(boundary: CrashConfig['boundary']): Promise<void> {
  if (config.boundary !== boundary) return;
  process.send?.({ kind: 'boundary', boundary } satisfies CrashReply);
  await new Promise(() => undefined);
}

// eslint-disable-next-line @typescript-eslint/unbound-method -- The interceptor restores the original receiver with commit.call(this, input).
const commit = SqliteRunStore.prototype.commit;
SqliteRunStore.prototype.commit = async function (input) {
  const intent = input.records.some((record) => record.kind === 'actionIntent');
  const result = input.records.some((record) => record.kind === 'actionResult');
  const progress = input.records.some(
    (record) =>
      record.kind === 'coreEvent' &&
      record.data.type === 'progress_assessed' &&
      record.data.reasonCode === 'action',
  );
  if (intent) await stopAt('beforeIntent');
  if (progress) await stopAt('beforeProgress');
  const committed = await commit.call(this, input);
  // Holding this return separates durable commit from acknowledgement to core.
  if (intent) await stopAt('afterIntent');
  if (result) await stopAt('afterResult');
  if (progress) await stopAt('afterProgress');
  if (
    input.records.some(
      (record) =>
        record.kind === 'coreEvent' && record.data.type === 'model_reserved',
    )
  )
    await stopAt('modelReserved');
  if (input.records.some((record) => record.kind === 'applicationEvent'))
    await stopAt('controlCommitted');
  return committed;
};

function actionResult(executionId: string): ActionResult {
  return {
    executionId,
    outcome: 'succeeded',
    reasonCode: 'sampled',
    underlyingSettled: true,
    confirmedEffects: { count: effects().length },
    unresolvedEffects: {},
    progress: {},
    stopCauseEventId: null,
  };
}

let enteredPlanning!: () => void;
const planning = new Promise<void>((resolve) => {
  enteredPlanning = resolve;
});
const revisionPath = join(config.directory, 'observation-revision.txt');
let revision = existsSync(revisionPath)
  ? Number(readFileSync(revisionPath, 'utf8'))
  : 0;
const agent = createAgent({
  applicationId: config.applicationId ?? 'crash-fixture',
  projectRoot: config.directory,
  modelStages: ['planning'],
  limits: {
    maxModelAttempts: 2,
    maxActionAttempts: 20,
    actionRetries: 1,
    maxNoProgress: config.target === 10 ? 1 : 3,
  },
  actions: [
    defineAction({
      id: 'sample',
      version: config.actionVersion ?? 1,
      description: 'Take one sample',
      tags: [],
      expectedEffects: { count: 1 },
      parameters: z.strictObject({
        value: z.number().default(config.parameterDefault ?? 7),
      }),
      retryMode: config.reconcile === 'missing' ? 'never' : 'reconcile',
      check: () => Promise.resolve({ outcome: 'allowed' }),
      execute: async (params, execution) => {
        const graph = execution.decision.graph;
        appendFileSync(
          effectPath,
          JSON.stringify({
            executionId: execution.executionId,
            depth: graph.goalPath.length,
            goal: graph.goals.find(
              (goal) => goal.id === graph.currentGoalRef.id,
            )!.description,
            parameter: params.value,
          }) + '\n',
          { encoding: 'utf8', flush: true },
        );
        await stopAt('afterEffect');
        if (config.cancelAfterEffect)
          await agent.emit(controlEvent('cancelRun'));
        return actionResult(execution.executionId);
      },
      ...(config.reconcile === 'missing'
        ? {}
        : {
            reconcile: (intent) => {
              appendFileSync(auditPath, JSON.stringify(intent) + '\n', {
                encoding: 'utf8',
                flush: true,
              });
              return Promise.resolve(
                config.reconcile === 'unknown'
                  ? {
                      outcome: 'unknown' as const,
                      reason: 'external_status_unavailable',
                    }
                  : effects().some(
                        (effect) => effect.executionId === intent.executionId,
                      )
                    ? {
                        outcome: 'performed' as const,
                        underlyingSettled: true as const,
                        result: actionResult(intent.executionId),
                      }
                    : {
                        outcome: 'notPerformed' as const,
                        underlyingSettled: true as const,
                        reason: 'no_effect_after_host_exit',
                      },
              );
            },
          }),
    }),
  ],
  environment: {
    observe: () => {
      // The environment owns its revision sequence across host restarts.
      writeFileSync(revisionPath, String(++revision), {
        encoding: 'utf8',
        flush: true,
      });
      return Promise.resolve({
        runId: 'run',
        id: 'observation',
        revision,
        observedAt: new Date().toISOString(),
        source: 'fixture',
        coverage: {
          scope: 'samples',
          completeness: 'complete',
          uncheckedScopes: [],
        },
        data: { count: { status: 'known', value: effects().length } },
      });
    },
  },
  planner: {
    plan: async (request) => {
      enteredPlanning();
      if (config.boundary === 'modelResponse') await agent.inspect('run');
      await stopAt('modelResponse');
      if (config.control !== undefined || config.duplicate === 'pauseRun')
        await new Promise(() => undefined);
      const current = request.context;
      const basis = {
        requestId: request.requestId,
        decisionEpoch: request.decisionEpoch,
        rootGoalRef: current.graph.rootGoalRef,
        currentGoalRef: current.graph.currentGoalRef,
        planRef: current.planRef,
        observationRef: {
          id: current.observation.id,
          revision: current.observation.revision,
        },
      };
      return config.nested
        ? {
            ...basis,
            outcome: 'decompose',
            guidance: 'Complete the branch before its sibling',
            nextTempId: 'first',
            goalOrder: ['first', 'second', 'third'],
            goals: [
              {
                tempId: 'group',
                parent: {
                  kind: 'accepted',
                  goalRef: current.graph.rootGoalRef,
                },
                description: 'Two samples',
                criteria: { count: 2 },
              },
              {
                tempId: 'first',
                parent: { kind: 'proposed', tempId: 'group' },
                description: 'First sample',
                criteria: { count: 1 },
              },
              {
                tempId: 'second',
                parent: { kind: 'proposed', tempId: 'group' },
                description: 'Second sample',
                criteria: { count: 2 },
              },
              {
                tempId: 'third',
                parent: {
                  kind: 'accepted',
                  goalRef: current.graph.rootGoalRef,
                },
                description: 'Third sample',
                criteria: { count: 3 },
              },
            ],
          }
        : {
            ...basis,
            outcome: 'continue',
            nextGoalRef: current.graph.currentGoalRef,
            guidance: 'Take a sample',
          };
    },
  },
  candidateProvider: {
    generate: (request) => {
      const current = request.context;
      if (current.planRef === null)
        throw new Error('A plan must precede candidate generation');
      const basis = {
        goalPathRef: 'samples',
        planRef: current.planRef,
        observationRef: {
          id: current.observation.id,
          revision: current.observation.revision,
        },
        constraintsVersion: current.constraintsVersion,
      };
      return Promise.resolve({
        ...basis,
        id: request.requestId,
        runId: 'run',
        rootGoalRef: current.graph.rootGoalRef,
        currentGoalRef: current.graph.currentGoalRef,
        goalPath: current.graph.goalPath,
        coverage: {
          generation: 'complete',
          checking: 'complete',
          uncheckedScopes: [],
          truncated: false,
          exclusions: [],
          informationGaps: [],
          capabilityGaps: [],
        },
        candidates: [
          {
            ...basis,
            id: 'next',
            candidateSetId: request.requestId,
            actionId: 'sample',
            actionVersion: config.actionVersion ?? 1,
            params: {},
            paramSources: {},
            description: 'Take a sample',
            expectedEffects: { count: 1 },
            cost: null,
            risk: null,
            source: 'fixture',
            goalRef: current.graph.currentGoalRef,
          },
        ],
      });
    },
  },
  selector: {
    select: (request) =>
      Promise.resolve({
        outcome: 'selected',
        decisionId: request.requestId,
        candidateSetId: request.candidates.id,
        candidateId: request.candidates.candidates[0]!.id,
      }),
  },
  verifier: {
    support: (criteria) =>
      Promise.resolve({
        outcome: 'supported',
        criteria: z.strictObject({ count: z.number() }).parse(criteria),
        requiredEvidence: ['/count'],
      }),
    verify: ({ goal, criteria, context }) => {
      const passed = effects().length >= criteria.count;
      return Promise.resolve({
        goalRef: { id: goal.id, version: goal.version },
        observationRef: {
          id: context.observation.id,
          revision: context.observation.revision,
        },
        ...(passed
          ? ({ outcome: 'passed', reason: null } as const)
          : ({ outcome: 'notYet', reason: 'more_samples' } as const)),
        ...(config.nested ? { progress: effects().length } : {}),
        evidence: {
          source: 'application',
          observationPaths: ['/count'],
          executionIds: [],
          details: {},
        },
      });
    },
  },
});

function controlEvent(control: 'pauseRun' | 'cancelRun'): ApplicationEvent {
  return {
    kind: 'application',
    eventId: 'operator-control',
    runId: 'run',
    type: 'operator_control',
    source: { kind: 'application', id: 'fixture' },
    observedAt: '2026-10-04T00:00:00.000Z',
    reasonCode: 'operator_request',
    impact: 'plan',
    timing: 'immediate',
    control,
    currentGoalRef: null,
    planRef: null,
    goalPathRef: null,
    executionId: null,
    observationRef: null,
    affectedGoalRefs: [],
    details: {},
  };
}

function reason(error: unknown): string {
  return error !== null && typeof error === 'object' && 'reason' in error
    ? String(error.reason)
    : String(error);
}

async function main(): Promise<CrashReply> {
  let run: RunHandle | undefined;
  let failure: string | undefined;
  try {
    if (config.operation === 'start')
      run = await agent.start({
        runId: 'run',
        goal: {
          id: 'root',
          version: 1,
          description: 'All samples',
          criteria: { count: config.target ?? (config.nested ? 3 : 1) },
          hardConstraints: [],
          limits: {},
          preferences: [],
        },
        effectiveConstraints: {},
      });
    else if (config.operation === 'resume') run = await agent.resume('run');
    else await agent.reconcile('run');
  } catch (error) {
    failure = reason(error);
  }
  if (config.control !== undefined) {
    await planning;
    await agent.emit(controlEvent(config.control));
  }
  let duplicate: CrashReply['duplicate'];
  if (config.duplicate !== undefined) {
    if (config.duplicate === 'pauseRun') await planning;
    const before = (await agent.inspect('run'))!.checkpoint.revision;
    const event = controlEvent(config.duplicate);
    let conflict = '';
    try {
      await agent.emit({ ...event, reasonCode: 'different_content' });
    } catch (error) {
      conflict = reason(error);
    }
    await Promise.all([agent.emit(event), agent.emit(event)]);
    duplicate = {
      before,
      after: (await agent.inspect('run'))!.checkpoint.revision,
      conflict,
    };
    if (run !== undefined) await agent.cancel('run', 'fixture_complete');
  }
  const status =
    run === undefined
      ? (await agent.inspect('run'))?.summary.status
      : (await run.result).status;
  // An unknown execution intentionally remains leased until the parent kills this host.
  if (failure === undefined) await agent.close();
  return {
    kind: failure === undefined ? 'done' : 'error',
    ...(status === undefined ? {} : { status }),
    ...(failure === undefined ? {} : { reason: failure }),
    ...(duplicate === undefined ? {} : { duplicate }),
  };
}

void main().then(
  (reply) => process.send?.(reply),
  (error: unknown) =>
    process.send?.({
      kind: 'error',
      reason: reason(error),
    } satisfies CrashReply),
);
