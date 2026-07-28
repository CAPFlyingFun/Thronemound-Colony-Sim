import Phaser from 'phaser';
import { ANT_CASTES, type AntCaste, type AntCasteId } from '../data/antCastes';
import { takeFood, type FoodNode } from '../game/FoodNode';
import type { PheromoneField } from '../systems/PheromoneField';

export type AntMode = 'wander' | 'seekFood' | 'carryFood' | 'respondAlarm' | 'defend';

export interface AntContext {
  nest: Phaser.Math.Vector2;
  foods: FoodNode[];
  pheromones: PheromoneField;
  now: number;
  onDeposit: (amount: number) => void;
}

export class Ant extends Phaser.GameObjects.Container {
  readonly idNumber: number;
  readonly casteId: AntCasteId;
  readonly caste: AntCaste;
  mode: AntMode = 'wander';
  private target = new Phaser.Math.Vector2();
  private nextThinkAt = 0;
  private carriedFood = 0;
  private lastAlarmRelayAt = 0;
  private lastTrailDropAt = 0;
  private readonly lastFoodPos = new Phaser.Math.Vector2();

  constructor(scene: Phaser.Scene, idNumber: number, casteId: AntCasteId, x: number, y: number) {
    super(scene, x, y);
    this.idNumber = idNumber;
    this.casteId = casteId;
    const caste = ANT_CASTES[casteId];
    this.caste = caste;

    const shadow = scene.add.ellipse(2, 5, 22 * caste.scale, 9 * caste.scale, 0x000000, 0.24);
    const abdomen = scene.add.ellipse(-7 * caste.scale, 0, 14 * caste.scale, 10 * caste.scale, caste.color);
    const thorax = scene.add.circle(2 * caste.scale, 0, 5 * caste.scale, 0x3a1a10);
    const head = scene.add.circle(10 * caste.scale, 0, 4.7 * caste.scale, caste.color);
    const mandible = scene.add.line(0, 0, 13 * caste.scale, -2, 19 * caste.scale, -5, 0xc98e54, 0.9);
    mandible.setLineWidth(Math.max(1, caste.scale));
    this.add([shadow, abdomen, thorax, head, mandible]);
    this.setSize(26 * caste.scale, 18 * caste.scale);
    scene.add.existing(this);
    this.chooseWanderTarget(x, y);
  }

  think(context: AntContext): void {
    if (context.now < this.nextThinkAt) return;
    this.nextThinkAt = context.now + Phaser.Math.Between(180, 420);

    const alarm = context.pheromones.strongest('alarm', this.x, this.y);
    if (alarm && Math.random() <= this.caste.alarmResponse) {
      this.mode = this.casteId === 'minor' && Math.random() < 0.45 ? 'respondAlarm' : 'defend';
      this.target.set(alarm.x, alarm.y);
      if (context.now - this.lastAlarmRelayAt > 1100 && Phaser.Math.Distance.Between(this.x, this.y, alarm.x, alarm.y) > 90) {
        context.pheromones.add({
          kind: 'alarm', x: this.x, y: this.y, strength: alarm.strength * 0.72,
          radius: Math.max(90, alarm.radius * 0.72), expiresAt: context.now + 3500, sourceAntId: this.idNumber,
        });
        this.lastAlarmRelayAt = context.now;
      }
      return;
    }

    if (this.carriedFood > 0) {
      this.mode = 'carryFood';
      this.target.copy(context.nest);
      return;
    }

    let closestFood: FoodNode | undefined;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const food of context.foods) {
      if (food.amount <= 0) continue;
      const distance = Phaser.Math.Distance.Between(this.x, this.y, food.x, food.y);
      if (distance < closestDistance && distance <= this.caste.awarenessRadius) {
        closestFood = food;
        closestDistance = distance;
      }
    }

    const foodSignal = context.pheromones.strongest('food', this.x, this.y);
    if (closestFood) {
      this.mode = 'seekFood';
      this.target.set(closestFood.x, closestFood.y);
    } else if (foodSignal) {
      // Trail crumbs advertise the FOOD's location (targetX/Y), so hearing any
      // crumb along a forager's return path recruits you to the source — the
      // starter sent ants to the crumb itself, which was an empty spot.
      this.mode = 'seekFood';
      this.target.set(foodSignal.targetX ?? foodSignal.x, foodSignal.targetY ?? foodSignal.y);
    } else if (Phaser.Math.Distance.Between(this.x, this.y, this.target.x, this.target.y) < 18) {
      this.mode = 'wander';
      this.chooseWanderTarget(context.nest.x, context.nest.y);
    }
  }

  move(deltaMs: number, context: AntContext): void {
    const distance = Phaser.Math.Distance.Between(this.x, this.y, this.target.x, this.target.y);
    if (distance > 2) {
      const angle = Phaser.Math.Angle.Between(this.x, this.y, this.target.x, this.target.y);
      const speedMultiplier = this.mode === 'defend' ? 1.18 : 1;
      const step = Math.min(distance, this.caste.speed * speedMultiplier * deltaMs / 1000);
      this.x += Math.cos(angle) * step;
      this.y += Math.sin(angle) * step;
      this.rotation = angle;
    }

    if (this.mode === 'seekFood') {
      const food = context.foods.find((f) => f.amount > 0 && Phaser.Math.Distance.Between(this.x, this.y, f.x, f.y) < 19);
      if (food) {
        const taken = takeFood(food, this.caste.carryCapacity);
        if (taken > 0) {
          this.carriedFood = taken;
          this.lastFoodPos.set(food.x, food.y);
          // Recruit ONLY while food remains — the starter advertised nodes at
          // the exact moment it deleted them.
          if (food.amount > 0) {
            context.pheromones.add({
              kind: 'food', x: food.x, y: food.y, strength: 1, radius: 230,
              expiresAt: context.now + 8500, createdAt: context.now,
              targetX: food.x, targetY: food.y, sourceAntId: this.idNumber,
            });
          }
          this.mode = 'carryFood';
          this.target.copy(context.nest);
        }
      }
    }

    // Return-path trail: a carrying ant lays crumbs pointing back at the food,
    // so the whole homeward walk becomes a recruitment corridor (the classic
    // ant-trail mechanic the starter only gestured at).
    if (this.mode === 'carryFood' && context.now - this.lastTrailDropAt > 480) {
      this.lastTrailDropAt = context.now;
      context.pheromones.add({
        kind: 'food', x: this.x, y: this.y, strength: 0.7, radius: 130,
        expiresAt: context.now + 6000, createdAt: context.now,
        targetX: this.lastFoodPos.x, targetY: this.lastFoodPos.y, sourceAntId: this.idNumber,
      });
    }

    if (this.mode === 'carryFood' && Phaser.Math.Distance.Between(this.x, this.y, context.nest.x, context.nest.y) < 28) {
      context.onDeposit(this.carriedFood);
      this.carriedFood = 0;
      this.mode = 'wander';
      this.chooseWanderTarget(context.nest.x, context.nest.y);
    }

    this.setDepth(Math.floor(this.y));
  }

  private chooseWanderTarget(centerX: number, centerY: number): void {
    const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
    const radius = Phaser.Math.Between(55, 290);
    this.target.set(centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius);
  }
}
