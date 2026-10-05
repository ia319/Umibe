import type { ActionCheck } from '#internal/contracts/action';
import type { CallControl } from '#internal/contracts/control';
import type {
  Candidate,
  CandidateExclusion,
} from '#internal/contracts/candidate';
import type {
  CandidateCheckEntry,
  CandidateCheckingReport,
  CandidateCheckingResult,
  PreparedCandidates,
} from '#internal/contracts/candidate-processing';
import { parseActionCheck } from '#internal/validation/action-check';
import { captureControl, invokeControlled } from './control.js';
import { candidateContractIssue, invocationFailure } from './diagnostics.js';
import { getPreparedCalls, registerCheckedCandidates } from './handles.js';

/**
 * Check each distinct prepared call sequentially against its captured context.
 * The exact preparation token is required; invalid tokens/control reject with
 * ContractError. Callback failures and interruptions return partial diagnostics
 * without an allowed set. Parameters are never parsed again; no action executes.
 */
export async function checkCandidates(
  prepared: PreparedCandidates,
  controlInput: CallControl,
): Promise<CandidateCheckingResult> {
  const calls = getPreparedCalls(prepared);
  const control = captureControl(controlInput);
  const entries: CandidateCheckEntry[] = [];
  const allowed: Candidate[] = [];
  const origins = new Map<string, string[]>();
  for (const entry of prepared.report.entries) {
    if (entry.callId === null || entry.outcome === 'excluded') continue;
    const ids = origins.get(entry.callId) ?? [];
    ids.push(entry.candidateId);
    origins.set(entry.callId, ids);
  }

  const snapshotReport = (complete: boolean): CandidateCheckingReport => {
    const remaining = prepared.set.candidates.slice(entries.length);
    const providerCoverage = prepared.providerSet.coverage;
    const counts = new Map<string, number>();
    for (const entry of entries) {
      if (entry.result.outcome === 'allowed') continue;
      // Prefix the outcome so a shared domain reason never merges denial with uncertainty.
      const reason = `${entry.result.outcome}:${entry.result.reason}`;
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    const exclusions: readonly CandidateExclusion[] = Object.freeze([
      ...prepared.set.coverage.exclusions,
      ...[...counts].map(([reason, count]) =>
        Object.freeze({ stage: 'checking' as const, reason, count }),
      ),
    ]);
    const pendingScopes = remaining.map(
      (candidate) => `core:candidate:${candidate.id}`,
    );
    // Completion can be interrupted after the final check or on an empty batch.
    if (!complete && pendingScopes.length === 0)
      pendingScopes.push('core:checking');
    return Object.freeze({
      total: prepared.set.candidates.length,
      completed: entries.length,
      allowed: allowed.length,
      denied: entries.filter((entry) => entry.result.outcome === 'denied')
        .length,
      unknown: entries.filter((entry) => entry.result.outcome === 'unknown')
        .length,
      remaining: remaining.length,
      entries: Object.freeze([...entries]),
      coverage: Object.freeze({
        ...providerCoverage,
        checking: complete ? providerCoverage.checking : 'partial',
        uncheckedScopes: Object.freeze([
          ...providerCoverage.uncheckedScopes,
          ...pendingScopes,
        ]),
        exclusions,
        informationGaps: Object.freeze([
          ...providerCoverage.informationGaps,
          ...entries.flatMap((entry) =>
            entry.result.outcome === 'unknown'
              ? [`core:candidate:${entry.candidateId}:${entry.result.reason}`]
              : [],
          ),
        ]),
      }),
    });
  };

  for (const candidate of prepared.set.candidates) {
    const result = await invokeControlled<unknown>(control, (control) =>
      calls.get(candidate.id)!.check(prepared.request.context, control),
    );
    if (result.outcome !== 'returned') {
      return Object.freeze({
        ...invocationFailure(result, 'checking', candidate.id),
        prepared,
        report: snapshotReport(false),
      });
    }
    let checked: ActionCheck;
    try {
      checked = parseActionCheck(result.value);
    } catch (error) {
      return Object.freeze({
        outcome: 'failed',
        stage: 'checking',
        candidateId: candidate.id,
        reason: 'invalid_result',
        issue: candidateContractIssue(error),
        prepared,
        report: snapshotReport(false),
      });
    }
    const stopped = control.signal.aborted
      ? 'cancelled'
      : Date.now() >= control.deadlineMs
        ? 'deadlineExceeded'
        : null;
    if (stopped !== null) {
      return Object.freeze({
        ...invocationFailure({ outcome: stopped }, 'checking', candidate.id),
        prepared,
        report: snapshotReport(false),
      });
    }
    entries.push(
      Object.freeze({
        candidateId: candidate.id,
        providerCandidateIds: Object.freeze(origins.get(candidate.id)!),
        result: checked,
      }),
    );
    if (checked.outcome === 'allowed') allowed.push(candidate);
  }

  const report = snapshotReport(true);
  const set = Object.freeze({
    ...prepared.set,
    candidates: Object.freeze(allowed),
    coverage: report.coverage,
  });
  const stopped = control.signal.aborted
    ? 'cancelled'
    : Date.now() >= control.deadlineMs
      ? 'deadlineExceeded'
      : null;
  if (stopped !== null) {
    return Object.freeze({
      ...invocationFailure({ outcome: stopped }, 'checking', null),
      prepared,
      report: snapshotReport(false),
    });
  }
  return Object.freeze({
    outcome: 'checked',
    checked: registerCheckedCandidates({ prepared, set, report }),
  });
}
