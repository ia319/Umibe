export interface GoalRef {
  readonly id: string;
  readonly version: number;
}

export interface PlanRef {
  readonly id: string;
  readonly version: number;
  readonly rootGoalVersion: number;
}

export interface ObservationRef {
  readonly id: string;
  readonly revision: number;
}
