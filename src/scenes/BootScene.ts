import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  create(): void {
    this.createTextures();
    this.scene.start('MainMenuScene');
  }

  private createTextures(): void {
    const graphics = this.add.graphics();
    graphics.fillStyle(0x5d4a2d, 1);
    graphics.fillEllipse(32, 22, 64, 42);
    graphics.fillStyle(0x2b170e, 1);
    graphics.fillEllipse(32, 24, 18, 10);
    graphics.generateTexture('nest', 64, 44);
    graphics.clear();

    graphics.fillStyle(0x9fb45f, 1);
    graphics.fillCircle(10, 10, 10);
    graphics.fillStyle(0xd6c36c, 1);
    graphics.fillCircle(8, 7, 3);
    graphics.generateTexture('food', 20, 20);
    graphics.destroy();
  }
}
