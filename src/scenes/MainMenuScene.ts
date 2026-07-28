import Phaser from 'phaser';

export class MainMenuScene extends Phaser.Scene {
  constructor() {
    super('MainMenuScene');
  }

  create(): void {
    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor(0x182016);

    const background = this.add.graphics();
    background.fillGradientStyle(0x263c22, 0x263c22, 0x11180f, 0x11180f, 1);
    background.fillRect(0, 0, width, height);

    for (let i = 0; i < 34; i++) {
      const x = Phaser.Math.Between(0, width);
      const y = Phaser.Math.Between(0, height);
      const length = Phaser.Math.Between(10, 34);
      const blade = this.add.line(0, 0, x, y, x + Phaser.Math.Between(-5, 5), y - length, 0x5f7f47, 0.45);
      blade.setOrigin(0, 0);
    }

    const title = this.add.text(width / 2, height * 0.22, 'THRONEMOUND', {
      fontFamily: 'Georgia, serif',
      fontSize: `${Math.max(36, Math.min(72, width * 0.085))}px`,
      color: '#f0d89b',
      stroke: '#26180f',
      strokeThickness: 6,
      align: 'center',
    }).setOrigin(0.5);

    this.add.text(width / 2, title.y + 62, 'COLONY SIM', {
      fontFamily: 'Arial, sans-serif', fontSize: '20px', color: '#d2b66f', letterSpacing: 8,
    }).setOrigin(0.5);

    this.add.text(width / 2, title.y + 105, 'A living world beneath every leaf.', {
      fontFamily: 'Georgia, serif', fontSize: '18px', color: '#c9d4b8', fontStyle: 'italic',
    }).setOrigin(0.5);

    const startY = Math.max(height * 0.5, 360);
    this.makeButton(width / 2, startY, 'NEW COLONY', true, () => this.scene.start('SurfaceScene'));
    this.makeButton(width / 2, startY + 68, 'CONTINUE', false);
    this.makeButton(width / 2, startY + 136, 'SETTINGS', true, () => this.showMessage('Settings will grow here as the colony evolves.'));
    this.makeButton(width / 2, startY + 204, 'ABOUT', true, () => this.showMessage('Hybrid 2.5D colony simulation built with Phaser and TypeScript.'));

    this.add.text(width / 2, height - 28, 'Prototype Branch • Generated art • No external assets required', {
      fontFamily: 'Arial, sans-serif', fontSize: '12px', color: '#80906f', align: 'center',
    }).setOrigin(0.5);
  }

  private makeButton(x: number, y: number, label: string, enabled: boolean, action?: () => void): void {
    const container = this.add.container(x, y);
    const panel = this.add.rectangle(0, 0, 270, 52, enabled ? 0x4f3b22 : 0x282a24, 0.96)
      .setStrokeStyle(2, enabled ? 0xb99755 : 0x54574e);
    const text = this.add.text(0, 0, label, {
      fontFamily: 'Arial, sans-serif', fontSize: '17px', color: enabled ? '#f3dfaa' : '#777b70', fontStyle: 'bold',
    }).setOrigin(0.5);
    container.add([panel, text]);

    if (enabled && action) {
      panel.setInteractive({ useHandCursor: true });
      panel.on('pointerover', () => panel.setFillStyle(0x6a4e2a, 1));
      panel.on('pointerout', () => panel.setFillStyle(0x4f3b22, 0.96));
      panel.on('pointerdown', action);
    }
  }

  private showMessage(message: string): void {
    const { width, height } = this.scale;
    const backdrop = this.add.rectangle(width / 2, height / 2, Math.min(width - 32, 440), 150, 0x11150f, 0.98)
      .setStrokeStyle(2, 0xb99755).setDepth(20);
    const copy = this.add.text(width / 2, height / 2 - 15, message, {
      fontFamily: 'Arial, sans-serif', fontSize: '16px', color: '#edf0e5', align: 'center', wordWrap: { width: Math.min(width - 80, 380) },
    }).setOrigin(0.5).setDepth(21);
    const dismiss = this.add.text(width / 2, height / 2 + 45, 'Tap to close', {
      fontFamily: 'Arial, sans-serif', fontSize: '13px', color: '#b99755',
    }).setOrigin(0.5).setDepth(21);
    backdrop.setInteractive().once('pointerdown', () => { backdrop.destroy(); copy.destroy(); dismiss.destroy(); });
  }
}
