# Thronemound SFX pack v1 (ElevenLabs, MP3 44.1kHz)

Suggested mapping to DigScene events / states:

| File | Hook | Notes |
|---|---|---|
| dig_chip_small.mp3 | DIG_CHIP (small) | randomize pitch +/-10% & volume per chip to avoid machine-gun repetition |
| dig_chip_large.mp3 | DIG_CHIP_LARGE | pairs with the cameraKick 0.012 nudge |
| dig_release.mp3 | DIG_RELEASE | pairs with the cameraKick 0.03 nudge |
| clod_pickup.mp3 | loose clod grabbed | |
| clod_drop.mp3 | clod deposited/dropped | |
| footsteps_soil.mp3 | planarSpeed > 0.2 | loop; rate-scale with speed band (crawl/walk/run) |
| wall_mount.mp3 | reorient() frame change | play on convex/concave transitions |
| land_thud.mp3 | grounded after airborne | |
| ambience_tunnel.mp3 | below SURFACE_Y | loop, crossfade with surface by depth |
| ambience_surface.mp3 | at/above surface | loop |
| founding_chime.mp3 | QueenFounding phase -> founded | |
| ui_tick.mp3 | HUD/menu interactions | |

Tips: play via WebAudio (not <audio>) for latency; decode once, pool sources;
duck ambience ~3dB under dig sounds; iOS needs a first user gesture to unlock audio.
