import * as THREE from 'three';

/**
 * 4-DOF serial arm: base yaw, then three parallel pitch joints (shoulder,
 * elbow, wrist). All pitch joints act in one vertical plane, so the IK is
 * solved analytically in that plane.
 *
 * A 3D position target leaves 1 continuous redundant DOF (the tool pitch
 * `phi`, i.e. the absolute angle of the last link in the arm plane) plus a
 * discrete elbow up/down branch. Together these parameterise the nullspace:
 * changing either re-solves the joints while the end-effector tip stays put.
 * (Turning the base 180° and mirroring the arm gives the same physical pose,
 * so it is not a separate branch; those poses are reached by sweeping phi.)
 */
export const DIMS = {
  H0: 1.0, // shoulder height above ground
  L1: 1.4, // upper arm
  L2: 1.2, // forearm
  L3: 0.5, // wrist -> tool tip; set per tool via setTool
};

export const TOOL_LENGTH = { gripper: 0.5, finger: 0.72 };

export interface Config {
  yaw: number;
  q1: number;
  q2: number;
  q3: number;
}

export interface Nullspace {
  phi: number;
  elbowUp: boolean;
}

export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function forwardKinematics(c: Config, out = new THREE.Vector3()) {
  const { H0, L1, L2, L3 } = DIMS;
  const a1 = c.q1;
  const a2 = a1 + c.q2;
  const a3 = a2 + c.q3;
  const r = L1 * Math.cos(a1) + L2 * Math.cos(a2) + L3 * Math.cos(a3);
  const h = H0 + L1 * Math.sin(a1) + L2 * Math.sin(a2) + L3 * Math.sin(a3);
  // Local +X of the yawed base maps to (cos yaw, 0, -sin yaw) in world space.
  return out.set(r * Math.cos(c.yaw), h, -r * Math.sin(c.yaw));
}

/** Exact IK for a tip position under a given nullspace choice; null if unreachable. */
export function solveIK(target: THREE.Vector3, ns: Nullspace, fallbackYaw = 0): Config | null {
  const { H0, L1, L2, L3 } = DIMS;
  const rho = Math.hypot(target.x, target.z);
  // Directly above the base the yaw is undefined; keep the previous heading.
  const yaw = rho < 1e-4 ? fallbackYaw : Math.atan2(-target.z, target.x);
  const h = target.y - H0;

  const wx = rho - L3 * Math.cos(ns.phi);
  const wy = h - L3 * Math.sin(ns.phi);
  let c2 = (wx * wx + wy * wy - L1 * L1 - L2 * L2) / (2 * L1 * L2);
  if (Math.abs(c2) > 1 + 1e-9) return null;
  c2 = Math.min(1, Math.max(-1, c2));

  const q2 = (ns.elbowUp ? -1 : 1) * Math.acos(c2);
  const q1 = Math.atan2(wy, wx) - Math.atan2(L2 * Math.sin(q2), L1 + L2 * Math.cos(q2));
  const q3 = ns.phi - q1 - q2;
  return { yaw: wrapAngle(yaw), q1: wrapAngle(q1), q2: wrapAngle(q2), q3: wrapAngle(q3) };
}

/**
 * IK for dragging: if the target is unreachable at the current tool pitch,
 * search the nearest pitch that works; if it is out of reach entirely, pull
 * it back onto the workspace boundary first.
 */
export function solveReachable(target: THREE.Vector3, ns: Nullspace, fallbackYaw: number) {
  const direct = solveIK(target, ns, fallbackYaw);
  if (direct) return { config: direct, phi: ns.phi };

  const { H0, L1, L2, L3 } = DIMS;
  const shoulder = new THREE.Vector3(0, H0, 0);
  const t = target.clone();
  const maxReach = L1 + L2 + L3 - 1e-3;
  const d = t.distanceTo(shoulder);
  if (d > maxReach) t.sub(shoulder).multiplyScalar(maxReach / d).add(shoulder);

  const step = Math.PI / 360;
  for (let i = 0; i <= 360; i++) {
    for (const s of i === 0 ? [0] : [1, -1]) {
      const phi = wrapAngle(ns.phi + s * i * step);
      const config = solveIK(t, { ...ns, phi }, fallbackYaw);
      if (config) return { config, phi };
    }
  }
  return null;
}
