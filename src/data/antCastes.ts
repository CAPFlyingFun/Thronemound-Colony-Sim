export type AntCasteId = 'minor' | 'worker' | 'major' | 'superMajor';

export interface AntCaste {
  id: AntCasteId;
  label: string;
  /**
   * Relative size multiplier, and NOT the source of how big an ant is drawn.
   *
   * A leftover from the 2D prototype, where it scaled a sprite. Real sizes now
   * live in `CASTE_LENGTH_MM` in src/anim/hexapod.ts, in millimetres, because a
   * model has to be scaled from its own measured length and a multiplier cannot
   * express that. Kept only for relative combat/roster ordering — if you need a
   * SIZE, take it from there, and do not add a second one here.
   *
   * The two taxonomies also differ: rigs exist for queen, worker and major;
   * this table has minor, worker, major and superMajor. Reconciling them is a
   * job for when the colony sim is wired up, not a thing to guess at now.
   */
  scale: number;
  speed: number;
  maxHealth: number;
  attack: number;
  carryCapacity: number;
  awarenessRadius: number;
  alarmResponse: number;
  color: number;
}

export const ANT_CASTES: Record<AntCasteId, AntCaste> = {
  minor: {
    id: 'minor', label: 'Minor', scale: 0.72, speed: 94, maxHealth: 45,
    attack: 5, carryCapacity: 1, awarenessRadius: 110, alarmResponse: 0.7, color: 0x5d2917,
  },
  worker: {
    id: 'worker', label: 'Worker', scale: 0.92, speed: 78, maxHealth: 70,
    attack: 9, carryCapacity: 2, awarenessRadius: 125, alarmResponse: 0.82, color: 0x70301a,
  },
  major: {
    id: 'major', label: 'Major', scale: 1.2, speed: 62, maxHealth: 125,
    attack: 18, carryCapacity: 4, awarenessRadius: 145, alarmResponse: 0.96, color: 0x843820,
  },
  superMajor: {
    id: 'superMajor', label: 'Super Major', scale: 1.55, speed: 48, maxHealth: 210,
    attack: 30, carryCapacity: 7, awarenessRadius: 165, alarmResponse: 1, color: 0x9a4528,
  },
};

export const STARTING_CASTES: AntCasteId[] = [
  'minor', 'minor', 'minor', 'worker', 'worker', 'worker', 'worker', 'major', 'major', 'superMajor',
];
