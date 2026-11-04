// Draws the tracked hands as small spheres. Our own code, because three.js's hand sphere model packs the
// visible joints into the first slots: when the headset skips a few joints, whole fingers vanish.
// Here every joint keeps its own slot. A joint the headset does not report is scaled to zero.
import { InstancedMesh, SphereGeometry, MeshBasicMaterial, DynamicDrawUsage, Matrix4, Vector3, Quaternion, Color } from 'three';

export const JOINT_NAMES = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal', 'pinky-finger-tip',
];

const THUMB_TIP = JOINT_NAMES.indexOf('thumb-tip');
const INDEX_TIP = JOINT_NAMES.indexOf('index-finger-tip');
const COLORS = { joint: new Color(0xffffff), tip: new Color(0xffd54a), pinch: new Color(0xf7931a) };

const HIDDEN = new Matrix4().makeScale(0, 0, 0);
const pos = new Vector3();
const quat = new Quaternion();
const scale = new Vector3();
const matrix = new Matrix4();

export function createHandMesh() {
  // transparent: the player fades a hand in while you use it and out when you stop
  const mesh = new InstancedMesh(new SphereGeometry(1, 10, 8), new MeshBasicMaterial({ transparent: true }), JOINT_NAMES.length);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  for (let i = 0; i < JOINT_NAMES.length; i++) {
    mesh.setMatrixAt(i, HIDDEN);
    mesh.setColorAt(i, COLORS.joint);
  }
  return mesh;
}

// hand = the three.js hand group ({ visible, joints }). Returns how many joints are shown.
// The two fingertips that make a pinch are larger. They turn orange while a pinch is detected.
export function updateHandMesh(mesh, hand, pinching) {
  let shown = 0;
  JOINT_NAMES.forEach((name, i) => {
    const joint = hand && hand.visible ? hand.joints[name] : null;
    if (joint && joint.visible) {
      joint.getWorldPosition(pos);
      const tip = i === THUMB_TIP || i === INDEX_TIP;
      scale.setScalar((joint.jointRadius || 0.006) * (tip ? 1.8 : 1.2));
      matrix.compose(pos, quat, scale);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, tip ? (pinching ? COLORS.pinch : COLORS.tip) : COLORS.joint);
      shown++;
    } else {
      mesh.setMatrixAt(i, HIDDEN);
    }
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  return shown;
}
