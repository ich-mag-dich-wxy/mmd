// boneVisualizer.js — 骨骼可视化调试工具 V2.0 (Points + Lines)
// 用 Three.js 线条显示骨骼结构，不同颜色区分匹配状态

import * as THREE from 'three';

export class BoneVisualizer {
  constructor(scene, mesh) {
    this.scene = scene;
    this.mesh = mesh;
    this.boneLines = null;
    this.bonePoints = null;
    this.boneLabels = null;
    this.visible = false;
    this.matchedBones = new Set();
    this.labelSprites = [];
  }

  setMatchedBones(matchedNames) {
    this.matchedBones = new Set(matchedNames);
  }

  create() {
    if (this.boneLines) {
      this.destroy();
    }

    const bones = this.mesh.skeleton.bones;
    const positions = [];
    const colors = [];

    // 颜色定义
    const matchedColor = new THREE.Color(0x00ff88);
    const unmatchedColor = new THREE.Color(0xff4444);
    const importantColor = new THREE.Color(0xffff00);

    // 重要骨骼列表
    const importantBones = ['足', 'ひざ', '膝', '上半身', '下半身', '首', '頭', '肩', '手首', '腕'];

    // 创建骨骼点
    for (const bone of bones) {
      const worldPos = new THREE.Vector3();
      bone.getWorldPosition(worldPos);
      positions.push(worldPos.x, worldPos.y, worldPos.z);

      const isMatched = this.matchedBones.has(bone.name);
      const isImportant = importantBones.some(ib => bone.name.includes(ib));

      let color;
      if (isMatched && isImportant) {
        color = importantColor;
      } else if (isMatched) {
        color = matchedColor;
      } else {
        color = unmatchedColor;
      }
      colors.push(color.r, color.g, color.b);
    }

    // 创建骨骼点
    const pointsGeom = new THREE.BufferGeometry();
    pointsGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    pointsGeom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const pointsMat = new THREE.PointsMaterial({
      size: 0.12,
      vertexColors: true,
      sizeAttenuation: true,
      transparent: true,
      opacity: 1.0,
    });

    this.bonePoints = new THREE.Points(pointsGeom, pointsMat);
    this.bonePoints.name = 'bone_visualizer_points';

    // 创建骨骼连线
    const linePositions = [];
    const lineColors = [];

    for (const bone of bones) {
      const parent = bone.parent;
      if (parent && bones.includes(parent)) {
        const childPos = new THREE.Vector3();
        const parentPos = new THREE.Vector3();
        bone.getWorldPosition(childPos);
        parent.getWorldPosition(parentPos);

        linePositions.push(
          parentPos.x, parentPos.y, parentPos.z,
          childPos.x, childPos.y, childPos.z
        );

        const childMatched = this.matchedBones.has(bone.name);
        const parentMatched = this.matchedBones.has(parent.name);
        const lineCol = (childMatched || parentMatched) ? new THREE.Color(0x88ff88) : new THREE.Color(0x666666);
        lineColors.push(lineCol.r, lineCol.g, lineCol.b, lineCol.r, lineCol.g, lineCol.b);
      }
    }

    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    lineGeom.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));

    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
    });

    this.boneLines = new THREE.LineSegments(lineGeom, lineMat);
    this.boneLines.name = 'bone_visualizer_lines';

    // 创建骨骼名称标签
    this.createLabels(bones);

    this.scene.add(this.bonePoints);
    this.scene.add(this.boneLines);

    this.visible = true;
    console.log(`[BoneVisualizer] 已创建骨骼可视化: ${bones.length} 个骨骼, ${this.matchedBones.size} 个匹配`);
  }

  createLabels(bones) {
    for (const sprite of this.labelSprites) {
      this.scene.remove(sprite);
    }
    this.labelSprites = [];

    const keyBonePatterns = ['足', 'ひざ', '膝', '上半身', '下半身', '首', '頭', '肩', '手首', '足首', '腕'];

    for (const bone of bones) {
      const isKeyBone = keyBonePatterns.some(p => bone.name.includes(p));
      if (!isKeyBone) continue;

      const worldPos = new THREE.Vector3();
      bone.getWorldPosition(worldPos);

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.width = 256;
      canvas.height = 64;

      const isMatched = this.matchedBones.has(bone.name);
      context.fillStyle = isMatched ? 'rgba(0, 200, 100, 0.8)' : 'rgba(200, 50, 50, 0.8)';
      context.fillRect(0, 0, 256, 64);

      context.fillStyle = '#ffffff';
      context.font = 'bold 24px Arial';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(bone.name, 128, 32);

      const texture = new THREE.CanvasTexture(canvas);
      const spriteMat = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0.9,
      });

      const sprite = new THREE.Sprite(spriteMat);
      sprite.position.copy(worldPos);
      sprite.position.y += 0.1;
      sprite.scale.set(0.4, 0.1, 1);

      this.scene.add(sprite);
      this.labelSprites.push(sprite);
    }
  }

  update() {
    if (!this.visible || !this.bonePoints) return;

    const bones = this.mesh.skeleton.bones;
    const positions = this.bonePoints.geometry.attributes.position.array;

    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i];
      const worldPos = new THREE.Vector3();
      bone.getWorldPosition(worldPos);
      positions[i * 3] = worldPos.x;
      positions[i * 3 + 1] = worldPos.y;
      positions[i * 3 + 2] = worldPos.z;
    }

    this.bonePoints.geometry.attributes.position.needsUpdate = true;

    if (this.boneLines) {
      const linePositions = this.boneLines.geometry.attributes.position.array;
      let idx = 0;

      for (const bone of bones) {
        const parent = bone.parent;
        if (parent && bones.includes(parent)) {
          const childPos = new THREE.Vector3();
          const parentPos = new THREE.Vector3();
          bone.getWorldPosition(childPos);
          parent.getWorldPosition(parentPos);

          linePositions[idx++] = parentPos.x;
          linePositions[idx++] = parentPos.y;
          linePositions[idx++] = parentPos.z;
          linePositions[idx++] = childPos.x;
          linePositions[idx++] = childPos.y;
          linePositions[idx++] = childPos.z;
        }
      }

      this.boneLines.geometry.attributes.position.needsUpdate = true;
    }

    // 更新标签
    const keyBonePatterns = ['足', 'ひざ', '膝', '上半身', '下半身', '首', '頭', '肩', '手首', '足首', '腕'];
    let labelIdx = 0;
    for (const bone of bones) {
      const isKeyBone = keyBonePatterns.some(p => bone.name.includes(p));
      if (!isKeyBone) continue;

      if (labelIdx < this.labelSprites.length) {
        const worldPos = new THREE.Vector3();
        bone.getWorldPosition(worldPos);
        this.labelSprites[labelIdx].position.copy(worldPos);
        this.labelSprites[labelIdx].position.y += 0.1;
        labelIdx++;
      }
    }
  }

  toggle() {
    if (!this.bonePoints) {
      this.create();
      return true;
    }

    this.visible = !this.visible;
    this.bonePoints.visible = this.visible;
    this.boneLines.visible = this.visible;
    for (const sprite of this.labelSprites) {
      sprite.visible = this.visible;
    }
    return this.visible;
  }

  show() {
    if (!this.bonePoints) this.create();
    this.visible = true;
    this.bonePoints.visible = true;
    this.boneLines.visible = true;
    for (const sprite of this.labelSprites) {
      sprite.visible = true;
    }
  }

  hide() {
    this.visible = false;
    if (this.bonePoints) this.bonePoints.visible = false;
    if (this.boneLines) this.boneLines.visible = false;
    for (const sprite of this.labelSprites) {
      sprite.visible = false;
    }
  }

  destroy() {
    if (this.bonePoints) {
      this.scene.remove(this.bonePoints);
      this.bonePoints.geometry.dispose();
      this.bonePoints.material.dispose();
      this.bonePoints = null;
    }
    if (this.boneLines) {
      this.scene.remove(this.boneLines);
      this.boneLines.geometry.dispose();
      this.boneLines.material.dispose();
      this.boneLines = null;
    }
    for (const sprite of this.labelSprites) {
      this.scene.remove(sprite);
      sprite.material.map.dispose();
      sprite.material.dispose();
    }
    this.labelSprites = [];
    this.visible = false;
  }

  highlightBone(boneName, colorHex = 0xffff00) {
    if (!this.bonePoints) return;

    const bones = this.mesh.skeleton.bones;
    const colors = this.bonePoints.geometry.attributes.color.array;
    const highlightColor = new THREE.Color(colorHex);

    for (let i = 0; i < bones.length; i++) {
      if (bones[i].name === boneName) {
        colors[i * 3] = highlightColor.r;
        colors[i * 3 + 1] = highlightColor.g;
        colors[i * 3 + 2] = highlightColor.b;
        this.bonePoints.geometry.attributes.color.needsUpdate = true;
        return;
      }
    }
  }

  resetColors() {
    if (!this.bonePoints) return;

    const bones = this.mesh.skeleton.bones;
    const colors = this.bonePoints.geometry.attributes.color.array;
    const matchedColor = new THREE.Color(0x00ff88);
    const unmatchedColor = new THREE.Color(0xff4444);
    const importantColor = new THREE.Color(0xffff00);
    const importantBones = ['足', 'ひざ', '膝', '上半身', '下半身', '首', '頭', '肩', '手首', '腕'];

    for (let i = 0; i < bones.length; i++) {
      const isMatched = this.matchedBones.has(bones[i].name);
      const isImportant = importantBones.some(ib => bones[i].name.includes(ib));

      let color;
      if (isMatched && isImportant) {
        color = importantColor;
      } else if (isMatched) {
        color = matchedColor;
      } else {
        color = unmatchedColor;
      }
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }

    this.bonePoints.geometry.attributes.color.needsUpdate = true;
  }

  getBoneInfo() {
    const bones = this.mesh.skeleton.bones;
    const info = [];

    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i];
      const worldPos = new THREE.Vector3();
      bone.getWorldPosition(worldPos);
      const parent = bone.parent;

      info.push({
        index: i,
        name: bone.name,
        matched: this.matchedBones.has(bone.name),
        position: { x: worldPos.x.toFixed(2), y: worldPos.y.toFixed(2), z: worldPos.z.toFixed(2) },
        parent: parent ? parent.name : null,
      });
    }

    return info;
  }
}
