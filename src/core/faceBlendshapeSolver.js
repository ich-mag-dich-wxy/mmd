// ═══════════════════════════════════════════════════════════
//  FaceBlendshapeSolver — JS 照搬移植
//  来源：plug/MiKaPo-main/src/lib/face-blendshape-solver.ts
//
//  输入：MediaPipe HolisticLandmarker 的 faceLandmarks[0]（478 点）
//  输出：
//    - boneStates：左目/右目 旋转四元数（@babylonjs/core Quaternion）
//    - morphWeights：まばたき / ウィンク / ウィンク右 / あ / ワ
// ═══════════════════════════════════════════════════════════

import { Quaternion } from "@babylonjs/core"

/**
 * @typedef {Object} BoneState
 * @property {string} name
 * @property {Quaternion} rotation
 */

/**
 * @typedef {Object} FaceMorphWeights
 * @property {number} まばたき
 * @property {number} ウィンク
 * @property {number} ウィンク右
 * @property {number} あ
 * @property {number} ワ
 */

/**
 * @typedef {Object} FaceSolverResult
 * @property {BoneState[]} boneStates
 * @property {FaceMorphWeights} morphWeights
 */

// MediaPipe 478 点面部关键点索引（照搬 plug face-blendshape-solver.ts FaceIndex）
const FaceIndex = {
  // Left eye (from camera's perspective, so appears on right side of image)
  LeftEyeUpper: 159,
  LeftEyeLower: 145,
  LeftEyeLeft: 33,
  LeftEyeRight: 133,
  LeftEyeIris: 468,

  // Right eye (from camera's perspective, so appears on left side of image)
  RightEyeUpper: 386,
  RightEyeLower: 374,
  RightEyeLeft: 362,
  RightEyeRight: 263,
  RightEyeIris: 473,

  // Mouth
  UpperLipTop: 13,
  LowerLipBottom: 14,
  MouthLeft: 61,
  MouthRight: 291,

  // Reference
  LeftEar: 234,
  RightEar: 454,
}

export class FaceBlendshapeSolver {
  /**
   * @param {{ smoothingFactor?: number }} [options]
   */
  constructor(options) {
    this.smoothingFactor = options?.smoothingFactor ?? 0.3
    this.prevLeftEyeOpenness = 1.0
    this.prevRightEyeOpenness = 1.0
    this.prevMouthOpenness = 0.0
    this.prevLeftEyeGaze = { x: 0, y: 0 }
    this.prevRightEyeGaze = { x: 0, y: 0 }
    this.prevSmile = 0.0
  }

  /**
   * @param {import("@mediapipe/tasks-vision").NormalizedLandmark[]} faceLandmarks
   * @returns {FaceSolverResult}
   */
  solve(faceLandmarks) {
    const defaultResult = {
      boneStates: [],
      morphWeights: {
        まばたき: 0,
        ウィンク: 0,
        ウィンク右: 0,
        あ: 0,
        ワ: 0,
      },
    }

    if (!faceLandmarks || faceLandmarks.length < 474) {
      return defaultResult
    }

    // Calculate eye gaze
    const leftEyeGaze = this.calculateEyeGaze(
      faceLandmarks[FaceIndex.LeftEyeLeft],
      faceLandmarks[FaceIndex.LeftEyeRight],
      faceLandmarks[FaceIndex.LeftEyeIris]
    )
    const rightEyeGaze = this.calculateEyeGaze(
      faceLandmarks[FaceIndex.RightEyeLeft],
      faceLandmarks[FaceIndex.RightEyeRight],
      faceLandmarks[FaceIndex.RightEyeIris]
    )

    // Smooth gaze
    const smoothedLeftGaze = {
      x: this.lerp(this.prevLeftEyeGaze.x, leftEyeGaze.x, 1 - this.smoothingFactor),
      y: this.lerp(this.prevLeftEyeGaze.y, leftEyeGaze.y, 1 - this.smoothingFactor),
    }
    const smoothedRightGaze = {
      x: this.lerp(this.prevRightEyeGaze.x, rightEyeGaze.x, 1 - this.smoothingFactor),
      y: this.lerp(this.prevRightEyeGaze.y, rightEyeGaze.y, 1 - this.smoothingFactor),
    }
    this.prevLeftEyeGaze = smoothedLeftGaze
    this.prevRightEyeGaze = smoothedRightGaze

    // Average gaze for both eyes
    const averageGaze = {
      x: (smoothedLeftGaze.x + smoothedRightGaze.x) / 2,
      y: (smoothedLeftGaze.y + smoothedRightGaze.y) / 2,
    }

    // Calculate eye rotations from gaze
    const leftEyeRotation = this.calculateEyeRotation(averageGaze.x, averageGaze.y)
    const rightEyeRotation = this.calculateEyeRotation(averageGaze.x, averageGaze.y)

    // Calculate eye openness (left/right swapped due to mirroring — 照搬 plug)
    let leftEyeOpenness = this.calculateEyeOpenness(
      faceLandmarks[FaceIndex.RightEyeLeft],
      faceLandmarks[FaceIndex.RightEyeRight],
      faceLandmarks[FaceIndex.RightEyeUpper],
      faceLandmarks[FaceIndex.RightEyeLower]
    )
    let rightEyeOpenness = this.calculateEyeOpenness(
      faceLandmarks[FaceIndex.LeftEyeLeft],
      faceLandmarks[FaceIndex.LeftEyeRight],
      faceLandmarks[FaceIndex.LeftEyeUpper],
      faceLandmarks[FaceIndex.LeftEyeLower]
    )

    leftEyeOpenness = this.lerp(this.prevLeftEyeOpenness, leftEyeOpenness, 1 - this.smoothingFactor)
    rightEyeOpenness = this.lerp(this.prevRightEyeOpenness, rightEyeOpenness, 1 - this.smoothingFactor)
    this.prevLeftEyeOpenness = leftEyeOpenness
    this.prevRightEyeOpenness = rightEyeOpenness

    // Mouth
    let mouthOpenness = this.calculateMouthOpenness(
      faceLandmarks[FaceIndex.UpperLipTop],
      faceLandmarks[FaceIndex.LowerLipBottom],
      faceLandmarks[FaceIndex.MouthLeft],
      faceLandmarks[FaceIndex.MouthRight]
    )

    let smile = this.calculateSmile(
      faceLandmarks[FaceIndex.UpperLipTop],
      faceLandmarks[FaceIndex.LowerLipBottom],
      faceLandmarks[FaceIndex.MouthLeft],
      faceLandmarks[FaceIndex.MouthRight]
    )

    mouthOpenness = this.lerp(this.prevMouthOpenness, mouthOpenness, 1 - this.smoothingFactor)
    smile = this.lerp(this.prevSmile, smile, 1 - this.smoothingFactor)
    this.prevMouthOpenness = mouthOpenness
    this.prevSmile = smile

    const leftBlink = 1 - leftEyeOpenness
    const rightBlink = 1 - rightEyeOpenness

    /** @type {BoneState[]} */
    const boneStates = [
      { name: "左目", rotation: leftEyeRotation },
      { name: "右目", rotation: rightEyeRotation },
    ]

    /** @type {FaceMorphWeights} */
    const morphWeights = {
      まばたき: (leftBlink + rightBlink) / 2,
      ウィンク: leftBlink > 0.5 && rightBlink < 0.3 ? leftBlink : 0,
      ウィンク右: rightBlink > 0.5 && leftBlink < 0.3 ? rightBlink : 0,
      あ: mouthOpenness,
      ワ: smile,
    }

    return { boneStates, morphWeights }
  }

  calculateEyeGaze(eyeLeft, eyeRight, iris) {
    const scale = 10.0
    const eyeCenterX = (eyeLeft.x * scale + eyeRight.x * scale) / 2
    const eyeCenterY = (eyeLeft.y * scale + eyeRight.y * scale) / 2
    const eyeWidth = Math.abs(eyeLeft.x * scale - eyeRight.x * scale)
    const eyeHeight = eyeWidth * 0.5

    const irisX = iris.x * scale
    const irisY = iris.y * scale

    const x = (irisX - eyeCenterX) / (eyeWidth * 0.5)
    const y = (irisY - eyeCenterY) / (eyeHeight * 0.5)

    return {
      x: this.clamp(x, -1, 1),
      y: this.clamp(y, -0.5, 0.5),
    }
  }

  calculateEyeRotation(gazeX, gazeY) {
    const maxHorizontalRotation = Math.PI / 6 // 30 degrees
    const maxVerticalRotation = Math.PI / 12 // 15 degrees

    const xRotation = gazeY * maxVerticalRotation
    const yRotation = -gazeX * maxHorizontalRotation

    return Quaternion.FromEulerAngles(xRotation, yRotation, 0)
  }

  calculateEyeOpenness(eyeLeft, eyeRight, eyeUpper, eyeLower) {
    const eyeHeight = this.distance(eyeUpper, eyeLower)
    const eyeWidth = this.distance(eyeLeft, eyeRight)
    if (eyeWidth === 0) return 1

    const aspectRatio = eyeHeight / eyeWidth
    const openRatio = 0.3
    const closedRatio = 0.1

    if (aspectRatio <= closedRatio) return 0
    if (aspectRatio >= openRatio) return 1
    return (aspectRatio - closedRatio) / (openRatio - closedRatio)
  }

  calculateMouthOpenness(upperLipTop, lowerLipBottom, mouthLeft, mouthRight) {
    const mouthHeight = this.distance(upperLipTop, lowerLipBottom)
    const mouthWidth = this.distance(mouthLeft, mouthRight)
    if (mouthWidth === 0) return 0

    const threshold = 0.18
    const ratio = mouthHeight / mouthWidth
    if (ratio <= threshold) return 0
    const openness = (ratio - threshold) / 0.2
    return this.clamp(openness, 0, 1)
  }

  calculateSmile(upperLipTop, lowerLipBottom, mouthLeft, mouthRight) {
    const mouthCenterY = (upperLipTop.y + lowerLipBottom.y) / 2
    const cornerY = (mouthLeft.y + mouthRight.y) / 2
    const rawSmile = mouthCenterY - cornerY

    const threshold = 0.008
    if (rawSmile <= threshold) return 0
    const smileAmount = (rawSmile - threshold) * 120
    return this.clamp(smileAmount, 0, 1)
  }

  distance(a, b) {
    const dx = a.x - b.x
    const dy = a.y - b.y
    const dz = (a.z || 0) - (b.z || 0)
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  clamp(value, min, max) {
    return Math.max(min, Math.min(max, value))
  }

  lerp(a, b, t) {
    return a + (b - a) * t
  }

  setSmoothingFactor(factor) {
    this.smoothingFactor = this.clamp(factor, 0, 0.95)
  }
}
