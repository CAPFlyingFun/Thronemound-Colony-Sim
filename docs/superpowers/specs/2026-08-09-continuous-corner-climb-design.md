# Continuous Corner Climb Design

## Goal
Replace the visible floor-to-wall hop with a continuous, contact-driven transition: front feet grip first, then the body curves onto the new surface under those anchors. Preserve walk/run intent and restore ordinary gait speed immediately after handoff.

## Current failure
v0.0.40 correctly stages one-foot-at-a-time contacts, but the body can still travel straight into a concave wall before `SurfaceWalker` has a usable wall-facing frame. Once the root is inside solid, `SurfaceWalker.hold()` takes its embedded-rescue path and eases toward the nearest outside surface. That rescue is useful as a fail-safe but reads as a hop because it starts after penetration rather than guiding the body around the corner. The post-corner `HANDOFF_GRACE` also intentionally suppresses the normal tripod trigger for two swing durations, which can read as a lingering gait/speed change.

## Approved behavior
- Normal movement remains the existing 3+3 alternating tripod gait.
- A sharp transition remains automatic and contact-driven: no grip, no climb.
- First front foot plants on the new surface, then the second front foot plants.
- Only after the leading pair is genuinely planted may the body begin rotating toward the new surface.
- No canned pause and no scripted jump. Forward input remains continuous.
- The body may slow only because planted-foot constraints reduce allowed movement, not because transition mode applies a special speed multiplier.
- `SurfaceWalker` remains the authority for seating/contact and the final body frame.
- The corner system may provide a bounded attitude guide after two front grips so `SurfaceWalker` can discover the concave wall before the root penetrates it.
- Middle and rear feet continue transferring one at a time.
- Handoff must preserve actual anchors and resume normal tripod cadence without a lingering slow state.

## Architecture
`CornerTurn` already owns the target surface normal and contact ownership. `LegDrive` will expose a read-only corner guide containing the target normal and transition progress. `IslandScene.moveSurface()` will apply that guide only after both leading feet are planted, before `walker.settle()`, using `SurfaceWalker.aimUp()` with a bounded rate. This rotates the ant's local frame progressively; `squareForward()` then naturally bends forward travel from floor-forward toward wall-up without moving the root directly.

The embedded-rescue path stays as an emergency fallback. The new normal path should keep the body out of solid during a successful corner, so that rescue should not fire during the reference floor-to-tree transition.

Post-corner handoff will become state-based instead of relying blindly on a fixed two-swing grace. The ordinary tripod trigger remains suppressed only while one-at-a-time cleanup is actually needed. As soon as planted feet are inside a safe gait workspace in the new frame, normal scheduling resumes. No speed multiplier or animation-rate override is introduced.

## Safety and scope
- No tree-specific branches.
- No root teleport or direct positional pull unless measurements prove the attitude guide cannot complete the transition.
- No changes to first-person stabilization, spine clearance, dodge, digging, or tree LOD logic.
- Keep support at four or more planted feet during staged transfer.
- Preserve the existing contact query and measured leg workspaces.

## Verification
Add deterministic corner tests for: two-front-grips before body tilt, progressive attitude change without root penetration, no embedded-rescue dependency in the reference corner, continuous post-handoff displacement, normal tripod cadence resuming without a fixed lingering slowdown, and unchanged flat-ground movement. Run `npm test`, `npm run typecheck`, and `npm run build`; use the landmark transition probe/screenshots when available.