import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/anim/legDrive.ts';
let src = readFileSync(path, 'utf8');

function replaceOnce(from, to, label) {
  const first = src.indexOf(from);
  if (first < 0) throw new Error(`missing patch target: ${label}`);
  if (src.indexOf(from, first + from.length) >= 0) throw new Error(`patch target is not unique: ${label}`);
  src = src.slice(0, first) + to + src.slice(first + from.length);
}

replaceOnce(
`    const cornerReportBeforeMove = this.corner.report(this.legs);
    if (corner.active && cornerReportBeforeMove.onNew < 2 && this.hasCornerPlane) {
      const clearance = from.clone().sub(this.cornerPlanePoint).dot(this.cornerPlaneNormal);
      const intoFace = shove.dot(this.cornerPlaneNormal);
      if (intoFace < -1e-9 && clearance + intoFace < CORNER_ROOT_SKIN) {
        const room = Math.max(0, clearance - CORNER_ROOT_SKIN);
        const scale = THREE.MathUtils.clamp(room / -intoFace, 0, 1);
        shove.multiplyScalar(scale);
      }
    }
`,
`    const cornerReportBeforeMove = this.corner.report(this.legs);
    const aimedFoot = corner.aimSlot
      ? cornerReportBeforeMove.feet.find((foot) => foot.slot === corner.aimSlot)
      : undefined;
    /*
     * Do NOT stop the approach while the FIRST front foot is reaching. The
     * v0.0.40 scheduler deliberately uses that ordinary forward creep to put
     * the opposite front home inside its measured workspace. My first guard
     * clipped from the instant any corner aim existed and the regression suite
     * caught the consequence: she could arm and plant one foot, but never got
     * the second, so every later row stalled too.
     *
     * Once one front foot is genuinely on the new surface AND the scheduler
     * has already found a valid target for a still-old foot, reach is no longer
     * hypothetical. That is the safe point to stop the ROOT crossing the face
     * while the second grip completes. A new-surface re-step is excluded by
     * the owner check, so it never turns this into a general climb-speed cap.
     */
    const acquiringSecondGrip = corner.active
      && cornerReportBeforeMove.onNew === 1
      && corner.aim !== null
      && aimedFoot?.owner === 'old';
    if (acquiringSecondGrip && this.hasCornerPlane) {
      const clearance = from.clone().sub(this.cornerPlanePoint).dot(this.cornerPlaneNormal);
      const intoFace = shove.dot(this.cornerPlaneNormal);
      if (intoFace < -1e-9 && clearance + intoFace < CORNER_ROOT_SKIN) {
        const room = Math.max(0, clearance - CORNER_ROOT_SKIN);
        const scale = THREE.MathUtils.clamp(room / -intoFace, 0, 1);
        shove.multiplyScalar(scale);
      }
    }
`,
'second-grip guard',
);

writeFileSync(path, src);
console.log('refined continuous corner guard applied with asserted target');
