import Phaser from 'phaser';
import { Ant } from '../entities/Ant';
import { STARTING_CASTES } from '../data/antCastes';
import { createColonyState, formatTime, totalPopulation } from '../game/GameState';
import { PheromoneField } from '../systems/PheromoneField';
import { createFoodNode, type FoodNode } from '../game/FoodNode';

export class SurfaceScene extends Phaser.Scene {
  private readonly worldSize = 2200;
  private readonly nest = new Phaser.Math.Vector2(1100, 1100);
  private ants: Ant[] = [];
  private foods: FoodNode[] = [];
  private foodSprites: Phaser.GameObjects.Image[] = [];
  private pheromoneGfx?: Phaser.GameObjects.Graphics;
  private pinchDist = 0;
  private pheromones = new PheromoneField();
  private state = createColonyState(STARTING_CASTES);
  private hud?: Phaser.GameObjects.Text;
  private dragging = false;
  private lastPointer = new Phaser.Math.Vector2();
  private nextThreatAt = 0;

  constructor() {
    super('SurfaceScene');
  }

  create(): void {
    this.cameras.main.setBounds(0, 0, this.worldSize, this.worldSize);
    this.cameras.main.setZoom(1);
    this.cameras.main.centerOn(this.nest.x, this.nest.y);
    this.drawWorld();
    // Trails render UNDER the ants (ants sit at depth=y, well above 5) but over
    // the ground fill — pheromones are finally something you can see fade.
    this.pheromoneGfx = this.add.graphics().setDepth(5);
    this.input.addPointer(1);   // enable a second touch pointer for pinch zoom
    this.spawnFoods(18);
    this.spawnAnts();
    this.createHud();
    this.configureCameraControls();
    this.input.keyboard?.on('keydown-ESC', () => this.scene.start('MainMenuScene'));
  }

  update(time: number, delta: number): void {
    this.state.timeMinutes += delta * 0.004;
    this.pheromones.decay(time);

    if (time >= this.nextThreatAt) {
      this.nextThreatAt = time + Phaser.Math.Between(9000, 15000);
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const x = this.nest.x + Math.cos(angle) * Phaser.Math.Between(180, 430);
      const y = this.nest.y + Math.sin(angle) * Phaser.Math.Between(180, 430);
      this.pheromones.add({ kind: 'alarm', x, y, strength: 1, radius: 260, expiresAt: time + 5200, createdAt: time });
      this.flashThreat(x, y);
    }

    const context = {
      nest: this.nest,
      foods: this.foods,
      pheromones: this.pheromones,
      now: time,
      onDeposit: (amount: number) => { this.state.food += amount; },
    };

    for (const ant of this.ants) {
      ant.think(context);
      ant.move(delta, context);
    }

    this.pruneFood();
    this.renderPheromones(time);
    this.updateHud();
    this.applyDayNightTint();
  }

  private drawWorld(): void {
    const graphics = this.add.graphics();
    graphics.fillStyle(0x556b35, 1);
    graphics.fillRect(0, 0, this.worldSize, this.worldSize);

    for (let i = 0; i < 850; i++) {
      const x = Phaser.Math.Between(0, this.worldSize);
      const y = Phaser.Math.Between(0, this.worldSize);
      const shade = Phaser.Math.RND.pick([0x617b3c, 0x49622f, 0x6f8345, 0x3f572c]);
      graphics.fillStyle(shade, Phaser.Math.FloatBetween(0.18, 0.45));
      graphics.fillEllipse(x, y, Phaser.Math.Between(7, 24), Phaser.Math.Between(3, 10));
    }

    graphics.fillStyle(0x68523a, 0.88);
    graphics.fillCircle(this.nest.x, this.nest.y, 130);
    graphics.fillStyle(0x59432f, 0.75);
    graphics.fillCircle(this.nest.x + 18, this.nest.y - 10, 95);
    graphics.setDepth(0);

    const nestSprite = this.add.image(this.nest.x, this.nest.y, 'nest').setScale(1.55).setDepth(this.nest.y);
    nestSprite.setInteractive({ useHandCursor: true }).on('pointerdown', () => this.emitAlarmNearNest());

    for (let i = 0; i < 150; i++) {
      const x = Phaser.Math.Between(40, this.worldSize - 40);
      const y = Phaser.Math.Between(40, this.worldSize - 40);
      const height = Phaser.Math.Between(18, 48);
      const grass = this.add.line(0, 0, x, y, x + Phaser.Math.Between(-8, 8), y - height, 0x2f4c24, 0.75)
        .setOrigin(0, 0).setLineWidth(Phaser.Math.Between(2, 4)).setDepth(y + 10);
      grass.setAlpha(Phaser.Math.FloatBetween(0.5, 0.9));
    }

    for (let i = 0; i < 34; i++) {
      const x = Phaser.Math.Between(60, this.worldSize - 60);
      const y = Phaser.Math.Between(60, this.worldSize - 60);
      const rock = this.add.ellipse(x, y, Phaser.Math.Between(30, 70), Phaser.Math.Between(18, 44), 0x777663, 1)
        .setStrokeStyle(2, 0x44483e, 0.5).setDepth(y);
      rock.setRotation(Phaser.Math.FloatBetween(-0.4, 0.4));
    }
  }

  private spawnFoods(count: number): void {
    for (let i = 0; i < count; i++) {
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const radius = Phaser.Math.Between(180, 720);
      const position = new Phaser.Math.Vector2(
        Phaser.Math.Clamp(this.nest.x + Math.cos(angle) * radius, 60, this.worldSize - 60),
        Phaser.Math.Clamp(this.nest.y + Math.sin(angle) * radius, 60, this.worldSize - 60),
      );
      this.foods.push(createFoodNode(position.x, position.y, Phaser.Math.Between(6, 14)));
      this.foodSprites.push(this.add.image(position.x, position.y, 'food').setDepth(position.y));
    }
  }

  private spawnAnts(): void {
    this.ants = STARTING_CASTES.map((caste, index) => {
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const radius = Phaser.Math.Between(30, 95);
      return new Ant(this, index + 1, caste, this.nest.x + Math.cos(angle) * radius, this.nest.y + Math.sin(angle) * radius);
    });
  }

  private createHud(): void {
    this.hud = this.add.text(12, 12, '', {
      fontFamily: 'Arial, sans-serif', fontSize: '15px', color: '#fff4cf',
      backgroundColor: 'rgba(25, 27, 19, 0.88)', padding: { x: 12, y: 9 },
      lineSpacing: 4,
    }).setScrollFactor(0).setDepth(100000);

    this.add.text(12, this.scale.height - 14, 'Drag to pan • Wheel/pinch to zoom • Tap mound for alarm test • Esc for menu', {
      fontFamily: 'Arial, sans-serif', fontSize: '12px', color: '#e8e1c8',
      backgroundColor: 'rgba(20, 22, 17, 0.72)', padding: { x: 8, y: 5 },
    }).setOrigin(0, 1).setScrollFactor(0).setDepth(100000);
  }

  private updateHud(): void {
    const modes = this.ants.reduce<Record<string, number>>((counts, ant) => {
      counts[ant.mode] = (counts[ant.mode] ?? 0) + 1;
      return counts;
    }, {});
    this.hud?.setText([
      `🐜 Population: ${totalPopulation(this.state)}   🍃 Food: ${this.state.food}`,
      `❤️ Colony Health: ${this.state.health}%   ☀️ ${formatTime(this.state.timeMinutes)}`,
      `Minor ${this.state.population.minor} • Worker ${this.state.population.worker} • Major ${this.state.population.major} • Super ${this.state.population.superMajor}`,
      `Searching ${modes.seekFood ?? 0} • Carrying ${modes.carryFood ?? 0} • Alarm ${((modes.respondAlarm ?? 0) + (modes.defend ?? 0))}`,
    ]);
  }

  // Prune BY INDEX so node k always owns sprite k. The starter spliced eaten
  // food from the MIDDLE of one array while popping sprites off the END of the
  // other — after the first pickup, eaten food kept a ghost sprite and real
  // food at the tail turned invisible (ants visibly "eating grass").
  private pruneFood(): void {
    for (let i = this.foods.length - 1; i >= 0; i--) {
      const node = this.foods[i];
      if (!node) continue;
      if (node.amount <= 0) {
        this.foods.splice(i, 1);
        this.foodSprites.splice(i, 1)[0]?.destroy();
      } else {
        // Shrink the sprite as the node is eaten down — visible depletion.
        this.foodSprites[i]?.setScale(0.55 + 0.45 * (node.amount / node.initialAmount));
      }
    }
    if (this.foods.length < 7 && Phaser.Math.Between(0, 120) === 0) this.spawnFoods(4);
  }

  private renderPheromones(now: number): void {
    const gfx = this.pheromoneGfx;
    if (!gfx) return;
    gfx.clear();
    for (const s of this.pheromones.snapshot()) {
      const frac = s.createdAt != null && s.expiresAt > s.createdAt
        ? Phaser.Math.Clamp((s.expiresAt - now) / (s.expiresAt - s.createdAt), 0, 1)
        : 1;
      if (s.kind === 'food') {
        gfx.fillStyle(0x9fe06a, 0.45 * frac * s.strength);
        gfx.fillCircle(s.x, s.y, 6);
      } else if (s.kind === 'alarm') {
        gfx.lineStyle(2, 0xff6a4a, 0.5 * frac);
        gfx.strokeCircle(s.x, s.y, 12 + 20 * (1 - frac));
      }
    }
  }

  private configureCameraControls(): void {
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.dragging = true;
      this.lastPointer.set(pointer.x, pointer.y);
    });
    this.input.on('pointerup', () => { this.dragging = false; this.pinchDist = 0; });
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      // Two fingers down = pinch zoom (the HUD promised it; the starter never
      // implemented it). One finger = pan, as before.
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;
      if (p1.isDown && p2.isDown) {
        const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
        if (this.pinchDist > 0) {
          const camera = this.cameras.main;
          camera.setZoom(Phaser.Math.Clamp(camera.zoom * (dist / this.pinchDist), 0.55, 1.7));
        }
        this.pinchDist = dist;
        this.dragging = false;
        return;
      }
      this.pinchDist = 0;
      if (!this.dragging || pointer.isDown === false) return;
      const camera = this.cameras.main;
      camera.scrollX -= (pointer.x - this.lastPointer.x) / camera.zoom;
      camera.scrollY -= (pointer.y - this.lastPointer.y) / camera.zoom;
      this.lastPointer.set(pointer.x, pointer.y);
    });
    this.input.on('wheel', (_pointer: Phaser.Input.Pointer, _objects: Phaser.GameObjects.GameObject[], _dx: number, dy: number) => {
      const camera = this.cameras.main;
      camera.setZoom(Phaser.Math.Clamp(camera.zoom - dy * 0.001, 0.55, 1.7));
    });
  }

  private applyDayNightTint(): void {
    const hour = (this.state.timeMinutes / 60) % 24;
    const nightStrength = hour >= 19 || hour < 6 ? 0.34 : hour >= 17 ? (hour - 17) * 0.12 : hour < 8 ? (8 - hour) * 0.1 : 0;
    this.cameras.main.setBackgroundColor(0x1c2818);
    this.cameras.main.setAlpha(1 - nightStrength * 0.08);
  }

  private emitAlarmNearNest(): void {
    const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
    const x = this.nest.x + Math.cos(angle) * 160;
    const y = this.nest.y + Math.sin(angle) * 160;
    this.pheromones.add({ kind: 'alarm', x, y, strength: 1, radius: 310, expiresAt: this.time.now + 6500, createdAt: this.time.now });
    this.flashThreat(x, y);
  }

  private flashThreat(x: number, y: number): void {
    const ring = this.add.circle(x, y, 22, 0xd44a35, 0.18).setStrokeStyle(4, 0xff9d72, 0.85).setDepth(y + 200);
    this.tweens.add({ targets: ring, radius: 66, alpha: 0, duration: 900, onComplete: () => ring.destroy() });
  }
}
