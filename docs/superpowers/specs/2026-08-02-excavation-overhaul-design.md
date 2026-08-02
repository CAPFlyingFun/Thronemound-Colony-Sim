# Excavation Overhaul Design

## Goal

Separate digging from surface locomotion so carving terrain can never feed unstable fresh surface normals back into the ant body or camera.

## Core rule

Surface locomotion owns the ant only when not actively excavating. Excavation locomotion owns the ant, camera, and tunnel centerline while DIG is active. The DensityField is edited by the excavation path, not used as the frame of reference for the ant that is currently creating it.

## Excavation mode

Entering DIG captures a stable excavation frame: position, forward, up, and right. Normal `hold()` / surface reseating is suspended. Manual steering changes the frame gradually; the ant advances along the centerline as terrain is removed.

The terrain view switches to an underground x-ray/wireframe presentation. The camera ignores terrain collision and may pass through solid soil. The camera remains third person and follows the stable excavation frame instead of switching between first and third person.

Leaving DIG hands the ant back to the existing surface locomotion. The existing crawler reacquires the nearest tunnel surface after excavation ends.

## Tunnel path system

One path representation powers both manual and preset digging. Manual digging appends short centerline segments as the player steers. Preset pieces generate the same centerline data.

Supported first-pass pieces:

- straight
- elbow / curved turn
- vertical or sloped shaft through the same straight primitive
- tee connector with a trunk and one branch
- chamber connector represented as a spherical/rounded expansion at a centerline point

The path stores physical millimetres, not frame time. Density subtraction samples the path and removes a tube around it. Removed volume remains the source for dirt-pellet accounting.

## Camera

Normal mode keeps the existing camera behavior. Excavation mode disables terrain clearance tests and camera mode switching. It follows the excavation frame with a fixed boom and stable up vector. If the ant occludes the view, model transparency is preferable to camera teleporting.

## Visual mode

DIG causes a global excavation presentation state. Packed terrain fades toward a dark translucent contour/wireframe look so the player can see the route through soil. Existing tunnels and the ant remain readable. This is presentation-only and must not change collision or density values.

## Non-goals for the first implementation

- Rewriting the working six-face surface crawler.
- Replacing the DensityField or Surface Nets terrain.
- Full colony AI path planning.
- Soil compaction or automatic re-merging of dropped pellets.

## Success criteria

1. DIG does not call normal surface reseating while active.
2. The ant frame stays stable during straight, sloped, and vertical excavation.
3. Camera position is independent of terrain collision while DIG is active.
4. Manual and preset digging both produce the same centerline representation.
5. Straight, elbow, tee, and chamber primitives are deterministic and unit tested.
6. Exiting DIG cleanly returns control to the current surface locomotion.