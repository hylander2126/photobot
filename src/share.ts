import * as THREE from 'three';
import { TOOL_LENGTH, type Nullspace } from './kinematics';
import type { ToolName } from './robotScene';

/**
 * Everything a share link carries. It lives in the URL hash, so it never
 * reaches a server and works on static hosting:
 *
 *   #pose=x,y,z,pitchDeg,u|d&cam=px,py,pz,tx,ty,tz&theme=2f6bd8&tool=gripper&shadow=0
 *
 * The pose is the tip position plus the nullspace choice, the same inputs the
 * IK uses, so it reproduces the arm exactly rather than approximating joints.
 */
export interface SharedState {
  target: THREE.Vector3;
  ns: Nullspace;
  camPos: THREE.Vector3;
  camTarget: THREE.Vector3;
  theme: string;
  tool: ToolName;
  shadow: boolean;
}

const DEG = 180 / Math.PI;
const num = (v: number, dp: number) => String(Number(v.toFixed(dp)));
const vec = (v: THREE.Vector3) => [v.x, v.y, v.z].map((n) => num(n, 4)).join(',');

export function encodeShare(s: SharedState): string {
  const p = new URLSearchParams();
  p.set('pose', `${vec(s.target)},${num(s.ns.phi * DEG, 2)},${s.ns.elbowUp ? 'u' : 'd'}`);
  p.set('cam', `${vec(s.camPos)},${vec(s.camTarget)}`);
  p.set('theme', s.theme.replace('#', '').toLowerCase());
  p.set('tool', s.tool);
  if (!s.shadow) p.set('shadow', '0');
  // URLSearchParams escapes commas; they're safe in a fragment and far easier to read.
  return p.toString().replace(/%2C/gi, ',');
}

/** Parse a location hash. Missing or malformed fields are simply left out. */
export function decodeShare(hash: string): Partial<SharedState> {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const out: Partial<SharedState> = {};
  const nums = (key: string, n: number) => {
    const parts = p.get(key)?.split(',') ?? [];
    const vals = parts.slice(0, n).map(Number);
    return vals.length === n && vals.every(Number.isFinite) ? vals : null;
  };

  const pose = p.get('pose')?.split(',');
  const poseNums = nums('pose', 4);
  if (pose && poseNums && (pose[4] === 'u' || pose[4] === 'd')) {
    out.target = new THREE.Vector3(poseNums[0], poseNums[1], poseNums[2]);
    out.ns = { phi: poseNums[3] / DEG, elbowUp: pose[4] === 'u' };
  }

  const cam = nums('cam', 6);
  if (cam) {
    out.camPos = new THREE.Vector3(cam[0], cam[1], cam[2]);
    out.camTarget = new THREE.Vector3(cam[3], cam[4], cam[5]);
  }

  const theme = p.get('theme');
  if (theme && /^[0-9a-f]{6}$/i.test(theme)) out.theme = `#${theme.toLowerCase()}`;

  const tool = p.get('tool');
  if (tool && tool in TOOL_LENGTH) out.tool = tool as ToolName;

  if (p.has('shadow')) out.shadow = p.get('shadow') !== '0';
  return out;
}

export function shareUrl(s: SharedState) {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}#${encodeShare(s)}`;
}
