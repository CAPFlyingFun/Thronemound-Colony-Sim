import { describe, expect, it } from 'vitest';
import { ANT_CASTES, STARTING_CASTES } from '../src/data/antCastes';
import { createColonyState, formatTime, totalPopulation } from '../src/game/GameState';
import { PheromoneField } from '../src/systems/PheromoneField';
import { createFoodNode, takeFood } from '../src/game/FoodNode';

describe('ant castes', () => {
  it('makes larger castes stronger but slower', () => {
    expect(ANT_CASTES.superMajor.scale).toBeGreaterThan(ANT_CASTES.major.scale);
    expect(ANT_CASTES.major.attack).toBeGreaterThan(ANT_CASTES.worker.attack);
    expect(ANT_CASTES.superMajor.speed).toBeLessThan(ANT_CASTES.worker.speed);
  });
});

describe('colony state', () => {
  it('counts mixed starting castes', () => {
    const state = createColonyState(STARTING_CASTES);
    expect(totalPopulation(state)).toBe(STARTING_CASTES.length);
    expect(state.population.superMajor).toBe(1);
  });

  it('formats wrapped time', () => {
    expect(formatTime(13 * 60 + 5)).toBe('1:05 PM');
    expect(formatTime(24 * 60 + 15)).toBe('12:15 AM');
  });
});

describe('food nodes', () => {
  it('limits each trip to carry capacity and depletes across trips', () => {
    const node = createFoodNode(0, 0, 10);
    expect(takeFood(node, 7)).toBe(7);   // super major trip
    expect(takeFood(node, 7)).toBe(3);   // only the remainder is left
    expect(takeFood(node, 7)).toBe(0);   // depleted
    expect(node.amount).toBe(0);
    expect(node.initialAmount).toBe(10);
  });
});

describe('pheromone field', () => {
  it('carries a trail target so crumbs recruit to the FOOD, not the crumb', () => {
    const field = new PheromoneField();
    field.add({ kind: 'food', x: 5, y: 5, radius: 100, strength: 0.7, expiresAt: 9000, targetX: 400, targetY: 300 });
    const signal = field.strongest('food', 0, 0);
    expect(signal?.targetX).toBe(400);
    expect(signal?.targetY).toBe(300);
  });

  it('returns the strongest nearby matching signal and expires old signals', () => {
    const field = new PheromoneField();
    field.add({ kind: 'food', x: 10, y: 10, radius: 50, strength: 0.5, expiresAt: 1000 });
    field.add({ kind: 'food', x: 20, y: 10, radius: 80, strength: 1, expiresAt: 2000 });
    expect(field.strongest('food', 15, 10)?.strength).toBe(1);
    field.decay(2500);
    expect(field.snapshot()).toHaveLength(0);
  });
});
