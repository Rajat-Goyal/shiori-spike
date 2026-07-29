export type WorkSessionConversationInput = Readonly<{
  draftId: string;
  draftVersion: number;
  durationMinutes: number | null;
  followUpQuestion: string | null;
  nextInput:
    | "duration"
    | "owner_time"
    | "timing_constraints"
    | null;
  preparationRequired: boolean | null;
  startAt: string | null;
  timingConstraints: string | null;
}>;

export type InitialWorkSessionConversationInput = Readonly<{
  durationMinutes: number | null;
  followUpQuestion: string | null;
  nextInput:
    | "duration"
    | "owner_time"
    | "timing_constraints"
    | null;
  preparationRequired: boolean;
  startAt: string | null;
  timingConstraints: string | null;
}>;
