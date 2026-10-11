import type { ObservationSource } from '#internal/contracts/adapters';
import type { CallControl } from '#internal/contracts/control';
import type { DecisionContext } from '#internal/contracts/context';
import type { JsonValue } from '#internal/contracts/json';
import type { InvocationResult } from '#internal/candidate/control';
import { captureCallback } from './callback-receipt.js';
import type { RunSession } from './session.js';

/**
 * Capture source snapshots without extending acceptance past the caller's deadline.
 * Late receipts stay observed. Callers validate observation shape, run identity,
 * and revisions before updating state; null context preserves initialization semantics.
 */
export async function captureObservation(
  session: RunSession,
  source: ObservationSource,
  context: DecisionContext | null,
  controlInput: CallControl,
): Promise<InvocationResult<JsonValue>> {
  const epoch = session.state.decision.decisionEpoch;
  const signal = controlInput.signal;
  const current = () =>
    session.state.observations.initialized
      ? session.canDispatch(epoch)
      : session.failure === null &&
        !session.ownershipSignal.aborted &&
        !signal.aborted &&
        session.state.decision.decisionEpoch === epoch &&
        ['created', 'paused'].includes(session.state.control.status);
  return captureCallback(
    session,
    {
      stage: 'observation',
      phase: context === null ? 'initialization' : 'execution',
      decisionEpoch: epoch,
      input: context,
    },
    controlInput,
    current,
    (control) => source.snapshot(context, control),
  );
}
