import * as THREE from 'three';

export class MotionBlender {
  constructor() {
    this.layers = {
      idle:    { weight: 0.3,  value: new THREE.Vector3() },
      emotion: { weight: 0.4,  value: new THREE.Vector3() },
      gesture: { weight: 1.0,  value: new THREE.Vector3() },
      gaze:    { weight: 0.6,  value: new THREE.Vector3() },
    };

    this._tmp = new THREE.Vector3();
    this._result = new THREE.Vector3();
  }

  setLayer(name, value, weight = null) {
    const layer = this.layers[name];
    if (!layer) return;
    if (value) layer.value.copy(value);
    if (weight !== null) layer.weight = weight;
  }

  blend(out = new THREE.Vector3()) {
    out.set(0, 0, 0);
    let totalWeight = 0;

    for (const [name, layer] of Object.entries(this.layers)) {
      if (layer.weight <= 0) continue;
      out.x += layer.value.x * layer.weight;
      out.y += layer.value.y * layer.weight;
      out.z += layer.value.z * layer.weight;
      totalWeight += layer.weight;
    }

    if (totalWeight > 0) {
      out.divideScalar(totalWeight);
    }

    return out;
  }

  blendActive() {
    const blended = this.blend(this._result);
    const gesture = this.layers.gesture;
    if (gesture.weight > 0.5 && gesture.value.lengthSq() > 0.001) {
      return { position: blended, isActive: true };
    }
    return { position: blended, isActive: false };
  }
}
