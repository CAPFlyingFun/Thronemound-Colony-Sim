export type AntCasteId = 'minor' | 'worker' | 'major' | 'superMajor';

export interface AntCaste {
  id: AntCasteId;
  label: string;
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
