# Thronemound Colony Sim

A browser-playable 3D ant colony simulation built with TypeScript, Phaser 3, and Vite.

## Current prototype

- Animated main menu
- Large generated surface world
- Mobile and desktop camera panning
- Four visibly different ant castes
- Independent ant decision loops
- Food discovery, hauling, and colony storage
- Local food and alarm pheromones
- Nearby alarm relay behavior
- Responsive colony HUD

## Run locally

```bash
npm install
npm run dev
```

## Verify

```bash
npm test
npm run typecheck
npm run build
```

## Deploy

The included GitHub Actions workflow builds and deploys the `main` branch through GitHub Pages. In repository settings, set Pages source to **GitHub Actions**.
