import type { AntCasteId } from '../data/antCastes';

export interface ColonyState {
  food: number;
  health: number;
  timeMinutes: number;
  population: Record<AntCasteId, number>;
}

export function createColonyState(castes: AntCasteId[]): ColonyState {
  const population: ColonyState['population'] = { minor: 0, worker: 0, major: 0, superMajor: 0 };
  castes.forEach((caste) => population[caste]++);
  return { food: 8, health: 100, timeMinutes: 7 * 60, population };
}

export function totalPopulation(state: ColonyState): number {
  return Object.values(state.population).reduce((total, value) => total + value, 0);
}

export function formatTime(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const hour24 = Math.floor(wrapped / 60);
  const minute = Math.floor(wrapped % 60);
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${minute.toString().padStart(2, '0')} ${suffix}`;
}
