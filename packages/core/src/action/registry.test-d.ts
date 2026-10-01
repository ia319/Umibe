import { assertType } from 'vitest';
import { z } from 'zod';
import type {
  ActionDefinition,
  PreparedAction,
} from '#internal/contracts/action';
import type { DecisionContext } from '#internal/contracts/adapters';
import { ActionRegistry, defineAction } from './registry.js';
import { result, execution } from './__tests__/fixtures.js';

const parameters = z.strictObject({
  target: z.string(),
  mode: z.enum(['walk', 'sprint']).default('walk'),
  count: z.number().default(1),
});

const move = defineAction({
  id: 'move',
  version: 1,
  description: 'Move to a target',
  tags: [],
  expectedEffects: {},
  parameters,
  check(context, params, control) {
    assertType<DecisionContext>(context);
    assertType<string>(params.target);
    assertType<'walk' | 'sprint'>(params.mode);
    assertType<number>(params.count);
    assertType<AbortSignal>(control.signal);
    // @ts-expect-error Normalization fills the numeric default; it is not a string.
    assertType<string>(params.count);
    // @ts-expect-error Callbacks cannot access fields absent from this schema.
    void params.missing;
    return Promise.resolve({ outcome: 'allowed' });
  },
  execute(params, context) {
    assertType<'walk' | 'sprint'>(params.mode);
    assertType<string>(context.executionId);
    return Promise.resolve(result);
  },
});

const collect = defineAction({
  id: 'collect',
  version: 1,
  description: 'Collect samples',
  tags: [],
  expectedEffects: {},
  parameters: z.object({ samples: z.array(z.number()) }),
  check(_context, params) {
    assertType<number[]>(params.samples);
    return Promise.resolve({ outcome: 'allowed' });
  },
  execute: () => Promise.resolve(result),
});

const registry = new ActionRegistry([move, collect]);
assertType<Promise<PreparedAction>>(registry.prepare({}));
declare const definition: ActionDefinition<typeof parameters>;
defineAction(definition);
// @ts-expect-error Register a validated factory result, not a raw definition.
registry.register(definition);

declare const prepared: PreparedAction;
// @ts-expect-error Prepared execution has no parameter argument to replace fixed values.
void prepared.execute({ target: 'south' }, execution);
// @ts-expect-error Fixed parameters expose readonly JSON data.
prepared.call.params.target = 'south';
// @ts-expect-error Capabilities are immutable catalog snapshots.
registry.capabilities[0] = move.capability;
