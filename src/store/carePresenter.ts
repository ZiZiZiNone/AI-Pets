import type { ScheduledPetTask } from '@/types/pet';

/**
 * Narrow port the care domain uses to report progress back to the stage.
 *
 * The care store owns progression and timers; it must not know about the stage store.
 * Everything it needs from presentation is expressed here and injected once at bind
 * time, which replaces the callbacks that used to be threaded through every call.
 */
export interface AudioPrefs {
  dnd: boolean;
  volume: number;
  petName: string;
}

export interface CarePresenter {
  schedule(task: ScheduledPetTask): void;
  audioPrefs(): AudioPrefs;
}

export const NOOP_PRESENTER: CarePresenter = {
  schedule: () => {},
  audioPrefs: () => ({ dnd: false, volume: 0, petName: '' }),
};
