// Smooth hands, like the Quest's own: the generic hand models of the WebXR Input Profiles project (MIT, (c) 2019
// Amazon, see assets/LICENSE-hand-models.md), moved with your tracked joints by three.js's hand mesh code.
// The models are inside the player file, so they need no network.
import { MeshLambertMaterial } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { XRHandModelFactory } from 'three/examples/jsm/webxr/XRHandModelFactory.js';
import leftModel from './assets/hand-left.glb';
import rightModel from './assets/hand-right.glb';

export const HAND_COLOR = 0xdfe7f5;
export const PINCH_COLOR = 0xf7a33a; // the hand glows orange while it pinches

// three.js asks this "loader" for "left.glb" or "right.glb". It answers from the bytes inside this file.
const embedded = {
  load(name, onLoad, onProgress, onError) {
    const bytes = name.startsWith('left') ? leftModel : rightModel;
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    new GLTFLoader().parse(data, '', onLoad, onError || ((err) => console.warn(`Hand model: ${err.message || err}`)));
  },
};

// Light, a little see-through, brighter at the edges. No light is needed: the colour is all emissive.
export function handMaterial() {
  const material = new MeshLambertMaterial({ color: 0x000000, emissive: HAND_COLOR, transparent: true, depthWrite: false });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
  float facing = abs(dot(normalize(normal), normalize(vViewPosition))); // 1 = the skin faces you, 0 = an edge
  diffuseColor.a *= mix(0.95, 0.35, facing);
  #include <opaque_fragment>`);
  };
  return material;
}

// A smooth hand for one three.js hand group. It appears when the headset reports that hand.
// onReady() runs when the model is in place.
export function addMeshHand(hand, material, onReady) {
  const factory = new XRHandModelFactory(embedded, (object) => {
    object.traverse((part) => {
      if (part.isMesh) {
        part.material = material;
        part.frustumCulled = false;
        part.renderOrder = 7; // after the subtitles and the menu: a hand in front of them stays in front
      }
    });
    if (onReady) onReady(object);
  });
  const model = factory.createHandModel(hand, 'mesh');
  hand.add(model);
  return model;
}
