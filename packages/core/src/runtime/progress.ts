import { createHash } from 'node:crypto';
import type { GoalGraphSnapshot } from '#internal/contracts/goal';
import type { GoalRef } from '#internal/contracts/references';
import { canonicalJson } from '#internal/candidate/identity';

export interface GoalProgress {
  readonly goalRef: GoalRef;
  readonly noProgress: number;
  readonly recoveryAttempts: number;
  readonly recoveryPlanned: boolean;
  readonly highWater: number | null;
  readonly achieved: readonly string[];
}

/** Preserve high-water marks across reversals and keep failed recovery separate from progress. */
export function assessProgress(
  previous: readonly GoalProgress[],
  before: GoalGraphSnapshot,
  after: GoalGraphSnapshot,
  attempt: 'baseline' | 'action' | 'planning',
  failed: boolean,
): readonly GoalProgress[] {
  const progress = new Map(previous.map((item) => [item.goalRef.id, item]));
  for (const ref of before.goalPath) {
    const goal = after.goals.find((item) => item.id === ref.id);
    if (!goal) continue;
    const prior = progress.get(ref.id);
    const assessment = goal.lastAssessment;
    const value = assessment?.progress ?? null;
    const changedVersion = prior?.goalRef.version !== goal.version;
    const highWater = changedVersion ? value : prior.highWater;
    const achieved = new Set(prior?.achieved ?? []);
    let stageProgress = false;
    if (attempt === 'action') {
      for (const item of before.goals) {
        if (
          item.lastAssessment?.outcome === 'passed' ||
          after.goals.find((goal) => goal.id === item.id)?.lastAssessment
            ?.outcome !== 'passed'
        )
          continue;
        let ancestor = item;
        while (ancestor.id !== goal.id && ancestor.kind === 'child') {
          const parentId = ancestor.parentGoalRef.id;
          ancestor = before.goals.find((goal) => goal.id === parentId)!;
        }
        if (ancestor.id !== goal.id) continue;
        const milestone = createHash('sha256')
          .update(canonicalJson(item.criteria), 'utf8')
          .digest('hex');
        if (!achieved.has(milestone)) {
          achieved.add(milestone);
          stageProgress = true;
        }
      }
    }
    const advanced =
      assessment?.outcome === 'passed' ||
      (value !== null
        ? highWater !== null && value > highWater
        : stageProgress);
    const passed = assessment?.outcome === 'passed';
    progress.set(goal.id, {
      goalRef: { id: goal.id, version: goal.version },
      noProgress: advanced
        ? 0
        : (prior?.noProgress ?? 0) + (attempt === 'baseline' ? 0 : 1),
      recoveryAttempts: passed
        ? 0
        : (prior?.recoveryAttempts ?? 0) +
          (attempt === 'action' && failed ? 1 : 0),
      recoveryPlanned: passed ? false : (prior?.recoveryPlanned ?? false),
      highWater:
        value === null ? highWater : Math.max(highWater ?? value, value),
      achieved: Object.freeze([...achieved]),
    });
  }
  return Object.freeze(
    [...progress.values()].filter((item) =>
      after.goals.some(
        (goal) =>
          goal.id === item.goalRef.id &&
          (goal.kind === 'root' ||
            goal.lifecycle === 'inProgress' ||
            goal.lifecycle === 'pending'),
      ),
    ),
  );
}
