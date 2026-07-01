// ═══════════════════════════════════════════════════════════
//  MiKaPo Clone — reze-engine + 照搬 plug 动捕流程
//
//  照搬 plug/MiKaPo-main/src/components/main-scene.tsx
//  照搬 plug/MiKaPo-main/src/components/motion-capture.tsx
//  照搬 plug/MiKaPo-main/src/lib/solver.ts (已存在于 src/core/mikapoSolver.js)
//  照搬 plug/MiKaPo-main/src/lib/face-blendshape-solver.ts (已移植 src/core/faceBlendshapeSolver.js)
//
//  引擎：reze-engine（与 plug 同款，WebGPU/Babylon 数学）
//  动捕流程：完全照搬 plug
//    - Solver.solve(landmarks) → BoneState[]
//    - FaceBlendshapeSolver.solve(faceLandmarks[0]) → {boneStates, morphWeights}
//    - applyPose: 四元数直接 new Quat(...) 写入 model.rotateBones(pose, 30)
//      （reze-engine 是左手系，与 solver 输出同空间，无需翻轴）
//    - applyFace: 左目/右目 旋转 + まばたき/ウィンク/ウィンク右/あ/ワ 表情
//    - calibrate(restPose)：从模型 rest 提取参考方向
//    - VMD 录制：30 FPS 采样，createVMD(frames, 2)，ShiftJIS 编码
// ═══════════════════════════════════════════════════════════

import { Engine, Quat, Vec3, parsePmxFolderInput, pmxFileAtRelativePath } from "reze-engine";
import { Vector3 } from "@babylonjs/core";
import { FilesetResolver, HolisticLandmarker } from "@mediapipe/tasks-vision";
import Encoding from "encoding-japanese";
import { Solver, SOLVER_REST_BONES } from "./src/core/mikapoSolver.js";
import { FaceBlendshapeSolver } from "./src/core/faceBlendshapeSolver.js";

/** 与 plug main-scene.tsx 一致的默认模型注册名 */
const DEFAULT_MODEL_KEY = "mikapo";

// ── 全局状态 ──
let engine = null;            // reze-engine Engine
let model = null;             // 当前 Model
let loadedModelName = DEFAULT_MODEL_KEY;
let solver = null;            // plug Solver
let faceSolver = null;        // plug FaceBlendshapeSolver
let restPoseReady = false;    // restPose 已 calibrate
let landmarker = null;
let mediaPipeReady = false;
let poseActive = false;
let landmarks = null;         // 最新 HolisticLandmarkerResult
let inputMode = null;         // 'camera' | 'image' | 'video' | null
let lastMedia = "VIDEO";      // 'IMAGE' | 'VIDEO' — 切换 runningMode 用
let stream = null;

// 当前帧的 pose / face 结果（供 VMD 录制采样）
let currentBoneStates = [];
let currentMorphWeights = null;

// detect 循环
let lastVideoTime = -1;
let lastImgSrc = "";
let frameCounter = 0;
const FRAME_SKIP = 2;

// VMD 录制
let isRecording = false;
let recordedFrames = [];

// ── 小工具 ──
const $ = (id) => document.getElementById(id);
function setBtn(id, props) {
  const el = document.getElementById(id);
  if (!el) return;
  if (props.disabled !== undefined) el.disabled = props.disabled;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.addClass) el.classList.add(props.addClass);
  if (props.removeClass) el.classList.remove(props.removeClass);
}
function setStatus(msg) {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
  console.log("[MiKaPo]", msg);
}
function fileStem(filename) {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(0, i) : filename;
}

// ═══════════════════════════════════════════════════════════
//  引擎初始化（照搬 plug main-scene.tsx initEngine）
// ═══════════════════════════════════════════════════════════
async function initEngine() {
  const canvas = document.getElementById("scene-canvas");
  if (!canvas) {
    setStatus("找不到 #scene-canvas");
    return;
  }
  try {
    engine = new Engine(canvas, {
      bloom: { color: new Vec3(0.5, 0.1, 0.9), intensity: 0.03 },
    });
    await engine.init();
    engine.setIKEnabled(false);
    engine.runRenderLoop(() => {
      const stats = engine.getStats();
      const fpsEl = document.getElementById("fps");
      if (fpsEl && stats) fpsEl.textContent = `${stats.fps} FPS`;
    });
    setStatus("引擎就绪，加载默认模型...");
    await loadDefaultModel();
  } catch (err) {
    setStatus(`引擎初始化失败: ${err.message}`);
    console.error("[MiKaPo] initEngine 失败:", err);
  }
}

// 照搬 plug main-scene.tsx 的材质预设
const MATERIAL_PRESETS = {
  eye: ["眼睛", "眼白", "目白", "右瞳", "左瞳", "眉毛", "eyebrow", "eyelash"],
  face: ["脸", "face01"],
  body: ["皮肤", "skin"],
  hair: ["头发", "hair_f"],
  cloth_smooth: [
    "衣服", "裙子", "裙带", "裙布", "外套", "外套饰", "裤子", "裤子0",
    "腿环", "发饰", "鞋子", "鞋子饰", "shirt", "shoes", "shorts",
    "trigger", "dress", "hair_accessory", "cloth01_shoes",
  ],
  stockings: ["袜子", "stockings"],
  metal: ["metal01", "earring"],
};

// ═══════════════════════════════════════════════════════════
//  默认模型加载（照搬 plug main-scene.tsx 默认 PMX 加载）
//  plug 用 /models/塞尔凯特/塞尔凯特.pmx，本地只有 刻晴，故用 刻晴
// ═══════════════════════════════════════════════════════════
async function loadDefaultModel() {
  try {
    model = await engine.loadModel(DEFAULT_MODEL_KEY, "/models/刻晴/刻晴.pmx");
    loadedModelName = DEFAULT_MODEL_KEY;
    console.log("[MiKaPo] 材质:", model.getMaterials());
    engine.setMaterialPresets(loadedModelName, MATERIAL_PRESETS);
    await new Promise((r) => requestAnimationFrame(r));
    buildRestPoseAndCalibrate();
    engine.addGround({ diffuseColor: new Vec3(0.9, 0.1, 0.9) });
    setStatus("模型就绪，可启动摄像头");
    setBtn("btn-camera", { disabled: !mediaPipeReady });
  } catch (err) {
    setStatus(`默认模型加载失败: ${err.message}（可点"加载 PMX 文件夹"换模型）`);
    console.error("[MiKaPo] 默认模型失败:", err);
  }
}

// ═══════════════════════════════════════════════════════════
//  PMX 文件夹加载（照搬 plug main-scene.tsx loadPmxFolder + parsePmxFolderInput）
// ═══════════════════════════════════════════════════════════
async function loadPmxFromFolder(files, pmxFile) {
  if (!engine) {
    window.alert("引擎尚未就绪，请稍候再试。");
    return;
  }
  setStatus(`加载模型: ${pmxFile.name}...`);
  const stem = fileStem(pmxFile.name);
  // 用随机 instanceKey，避免和默认模型冲突
  const instanceKey = `u_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  try {
    try {
      engine.removeModel(loadedModelName);
    } catch {
      /* 旧模型名可能已失效，忽略 */
    }
    model = await engine.loadModel(instanceKey, { files, pmxFile });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    model.setName(stem);
    loadedModelName = instanceKey;
    engine.setMaterialPresets(loadedModelName, MATERIAL_PRESETS);
    buildRestPoseAndCalibrate();
    setStatus("模型就绪，可启动摄像头");
    setBtn("btn-camera", { disabled: !mediaPipeReady });
  } catch (err) {
    setStatus(`加载失败: ${err.message}`);
    console.error("[MiKaPo] PMX 加载失败:", err);
    window.alert(err.message || String(err));
  }
}

// 照搬 plug main-scene.tsx onPickPmxFolder + onConfirmPmxPick
async function onPmxFolderPicked(e) {
  try {
    const picked = parsePmxFolderInput(e.target.files);
    e.target.value = "";
    if (picked.status === "empty") return;
    if (picked.status === "not_directory") {
      window.alert("请选择文件夹，不要选择单个文件。");
      return;
    }
    if (picked.status === "no_pmx") {
      window.alert("所选文件夹中没有 .pmx 文件。");
      return;
    }
    if (picked.status === "single") {
      await loadPmxFromFolder(picked.files, picked.pmxFile);
      return;
    }
    // multiple: 让用户选一个
    const choice = window.prompt(
      `找到 ${picked.pmxRelativePaths.length} 个 PMX，请输入序号(1-${picked.pmxRelativePaths.length}):\n` +
        picked.pmxRelativePaths.map((p, i) => `${i + 1}. ${p}`).join("\n"),
      "1"
    );
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= picked.pmxRelativePaths.length) {
      setStatus("已取消");
      return;
    }
    const pmxFile = pmxFileAtRelativePath(picked.files, picked.pmxRelativePaths[idx]);
    if (!pmxFile) {
      window.alert("找不到所选的 PMX 文件。");
      return;
    }
    await loadPmxFromFolder(picked.files, pmxFile);
  } catch (err) {
    console.error("[MiKaPo] pmx-folder:", err);
    window.alert(err.message || String(err));
  }
}

// ═══════════════════════════════════════════════════════════
//  buildRestPose + calibrate（照搬 plug main-scene.tsx buildRestPose）
//  reze-engine 的 model.getBoneWorldPosition 返回 {x,y,z}，
//  plug 用 `new Vector3(p.x, p.y, p.z)` 包成 Babylon Vector3 后传给 solver.calibrate。
//  solver 已经是 Babylon 类型，所以这里不需要任何坐标翻转。
// ═══════════════════════════════════════════════════════════
function buildRestPoseAndCalibrate() {
  if (!model) return;
  if (!solver) solver = new Solver();
  const restWorldPos = {};
  for (const name of SOLVER_REST_BONES) {
    try {
      const p = model.getBoneWorldPosition(name);
      if (p) restWorldPos[name] = new Vector3(p.x, p.y, p.z);
    } catch {
      // 骨骼缺失 — solver 会回退到 DEFAULT_REFS
    }
  }
  solver.calibrate(restWorldPos);
  restPoseReady = true;
  console.log("[MiKaPo] calibrate 完成，骨骼数:", Object.keys(restWorldPos).length);
}

// ═══════════════════════════════════════════════════════════
//  applyPose（照搬 plug main-scene.tsx applyPose）
//  reze-engine 是左手系（Babylon 风格），solver 输出也是 Babylon 四元数，
//  所以直接 new Quat(x,y,z,w) 即可——不做任何坐标翻转。
//  rotateBones(pose, 30) 语义：30ms slerp 补间（与 plug 一致）。
// ═══════════════════════════════════════════════════════════
function applyPose(boneStates) {
  if (!engine || !model || !boneStates || boneStates.length === 0) return;
  const pose = {};
  for (const bone of boneStates) {
    pose[bone.name] = new Quat(
      bone.rotation.x,
      bone.rotation.y,
      bone.rotation.z,
      bone.rotation.w
    );
  }
  if (Object.keys(pose).length > 0) {
    model.rotateBones(pose, 30);
  }
}

// ═══════════════════════════════════════════════════════════
//  applyFace（照搬 plug main-scene.tsx applyFace）
//  - 左目/右目 旋转走 rotateBones
//  - まばたき/ウィンク/ウィンク右/あ/ワ 走 setMorphWeight(name, weight, 30)
// ═══════════════════════════════════════════════════════════
function applyFace(faceResult) {
  if (!engine || !model || !faceResult) return;
  if (faceResult.boneStates && faceResult.boneStates.length > 0) {
    const pose = {};
    for (const bone of faceResult.boneStates) {
      pose[bone.name] = new Quat(
        bone.rotation.x,
        bone.rotation.y,
        bone.rotation.z,
        bone.rotation.w
      );
    }
    model.rotateBones(pose, 30);
  }
  const mw = faceResult.morphWeights;
  if (mw) {
    model.setMorphWeight("まばたき", mw.まばたき, 30);
    model.setMorphWeight("ウィンク", mw.ウィンク, 30);
    model.setMorphWeight("ウィンク右", mw.ウィンク右, 30);
    model.setMorphWeight("あ", mw.あ, 30);
    model.setMorphWeight("ワ", mw.ワ, 30);
  }
}

// 重置模型（照搬 plug main-scene.tsx resetModel）
function resetModel() {
  if (!model) return;
  model.resetAllBones();
  model.resetAllMorphs();
}

// ═══════════════════════════════════════════════════════════
//  MediaPipe HolisticLandmarker（照搬 plug motion-capture.tsx initLandmarker）
// ═══════════════════════════════════════════════════════════
async function initLandmarker() {
  setStatus("加载 MediaPipe WASM...");
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm"
  );
  const createOptions = {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task",
      delegate: "GPU",
    },
    minPosePresenceConfidence: 0.7,
    minPoseDetectionConfidence: 0.7,
    minFaceDetectionConfidence: 0.4,
    minHandLandmarksConfidence: 0.95,
    runningMode: "VIDEO",
  };
  try {
    landmarker = await HolisticLandmarker.createFromOptions(vision, createOptions);
  } catch (gpuError) {
    console.warn("[MiKaPo] GPU 失败，回退 CPU:", gpuError);
    landmarker = await HolisticLandmarker.createFromOptions(vision, {
      ...createOptions,
      baseOptions: { ...createOptions.baseOptions, delegate: "CPU" },
    });
  }
  // 预热（照搬 plug）
  try {
    const warmupCanvas = document.createElement("canvas");
    warmupCanvas.width = 256;
    warmupCanvas.height = 256;
    const ctx = warmupCanvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, 256, 256);
    }
    await new Promise((resolve) => {
      landmarker.detectForVideo(warmupCanvas, performance.now(), () => resolve());
    });
  } catch (e) {
    console.warn("[MiKaPo] 预热失败（忽略）:", e);
  }
  mediaPipeReady = true;
  setBtn("btn-camera", { disabled: !model || !restPoseReady });
  setBtn("btn-image", { disabled: false });
  setBtn("btn-video", { disabled: false });
  setStatus("MediaPipe 就绪");
  // 启动 detect 循环（照搬 plug motion-capture.tsx detect）
  startDetectLoop();
}

// 照搬 plug motion-capture.tsx 的 detect 循环
// 每帧根据 inputMode 决定走 video 还是 image 分支；
// FRAME_SKIP=2：隔帧检测以省性能；
// 拿到结果后立即 solve + applyPose + applyFace。
function startDetectLoop() {
  const detect = () => {
    frameCounter++;
    const shouldProcess = frameCounter % FRAME_SKIP === 0;

    const videoEl = document.getElementById("pose-video");
    const imageEl = document.getElementById("pose-image");

    if (
      videoEl &&
      videoEl.videoWidth > 0 &&
      lastVideoTime !== videoEl.currentTime &&
      (inputMode === "camera" || inputMode === "video")
    ) {
      lastVideoTime = videoEl.currentTime;
      if (shouldProcess) {
        try {
          landmarker.detectForVideo(videoEl, performance.now(), (result) => {
            if (result && result.poseWorldLandmarks && result.poseWorldLandmarks.length > 0) {
              landmarks = result;
              onLandmarks();
            }
          });
        } catch (e) {
          /* skip */
        }
      }
    } else if (
      imageEl &&
      imageEl.src &&
      imageEl.src !== lastImgSrc &&
      imageEl.complete &&
      imageEl.naturalWidth > 0 &&
      inputMode === "image"
    ) {
      lastImgSrc = imageEl.src;
      try {
        landmarker.detect(imageEl, (result) => {
          if (result && result.poseWorldLandmarks && result.poseWorldLandmarks.length > 0) {
            landmarks = result;
            onLandmarks();
          }
        });
      } catch (e) {
        /* skip */
      }
    }
    requestAnimationFrame(detect);
  };
  detect();
}

// 照搬 plug motion-capture.tsx useEffect 中的 solve + applyPose + applyFace
function onLandmarks() {
  if (!landmarks || !model || !restPoseReady) return;
  if (!solver) solver = new Solver();
  if (!faceSolver) faceSolver = new FaceBlendshapeSolver({ smoothingFactor: 0.4 });

  // 身体
  const pose = solver.solve(landmarks);
  if (pose) {
    currentBoneStates = pose;
    applyPose(pose);
  }
  // 脸部
  if (landmarks.faceLandmarks && landmarks.faceLandmarks[0]) {
    const faceResult = faceSolver.solve(landmarks.faceLandmarks[0]);
    currentMorphWeights = faceResult.morphWeights;
    applyFace(faceResult);
  }
}

// ═══════════════════════════════════════════════════════════
//  摄像头/图片/视频（照搬 plug motion-capture.tsx）
// ═══════════════════════════════════════════════════════════
async function toggleCamera() {
  if (poseActive && inputMode === "camera") {
    stopCapture();
    return;
  }
  if (!model || !restPoseReady) {
    setStatus("请先加载模型");
    return;
  }
  if (!mediaPipeReady) {
    setStatus("MediaPipe 未就绪");
    return;
  }
  try {
    stopCapture();
    resetModel();
    if (solver) solver.reset();
    if (landmarker.runningMode !== "VIDEO") {
      await landmarker.setOptions({ runningMode: "VIDEO" });
    }
    lastMedia = "VIDEO";
    stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const videoEl = document.getElementById("pose-video");
    if (!videoEl) throw new Error("video 元素未就绪");
    videoEl.srcObject = stream;
    await videoEl.play();
    inputMode = "camera";
    poseActive = true;
    lastVideoTime = -1;
    setBtn("btn-camera", { text: "停止摄像头", addClass: "danger", removeClass: "primary" });
    setStatus("摄像头已启动");
  } catch (err) {
    setStatus(`摄像头失败: ${err.message}`);
    console.error("[MiKaPo] 摄像头失败:", err);
    inputMode = null;
    poseActive = false;
  }
}

async function detectImage(file) {
  if (!model || !restPoseReady || !mediaPipeReady) {
    setStatus("请先加载模型并等待 MediaPipe");
    return;
  }
  stopCapture();
  resetModel();
  if (solver) solver.reset();
  const url = URL.createObjectURL(file);
  const imgEl = document.getElementById("pose-image");
  const videoEl = document.getElementById("pose-video");
  if (!imgEl) { setStatus("image 元素未就绪"); return; }
  if (landmarker.runningMode !== "IMAGE") {
    await landmarker.setOptions({ runningMode: "IMAGE" });
  }
  lastMedia = "IMAGE";
  if (videoEl) videoEl.style.display = "none";
  imgEl.style.display = "block";
  imgEl.src = url;
  lastImgSrc = "";
  inputMode = "image";
  poseActive = true;
  setStatus("图片提取中...");
}

async function detectVideo(file) {
  if (!model || !restPoseReady || !mediaPipeReady) {
    setStatus("请先加载模型并等待 MediaPipe");
    return;
  }
  stopCapture();
  resetModel();
  if (solver) solver.reset();
  const url = URL.createObjectURL(file);
  const videoEl = document.getElementById("pose-video");
  const imgEl = document.getElementById("pose-image");
  if (!videoEl) { setStatus("video 元素未就绪"); return; }
  if (landmarker.runningMode !== "VIDEO") {
    await landmarker.setOptions({ runningMode: "VIDEO" });
  }
  lastMedia = "VIDEO";
  if (imgEl) imgEl.style.display = "none";
  videoEl.style.display = "block";
  videoEl.srcObject = null;
  videoEl.src = url;
  videoEl.currentTime = 0;
  await videoEl.play();
  inputMode = "video";
  poseActive = true;
  lastVideoTime = -1;
  setStatus("视频提取中...");
  videoEl.onended = () => {
    setStatus("视频播放结束");
  };
}

function stopCapture() {
  poseActive = false;
  inputMode = null;
  landmarks = null;
  currentBoneStates = [];
  currentMorphWeights = null;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  const videoEl = document.getElementById("pose-video");
  if (videoEl) {
    videoEl.pause();
    videoEl.srcObject = null;
    videoEl.src = "";
  }
  setBtn("btn-camera", { text: "启动摄像头", addClass: "primary", removeClass: "danger" });
  setStatus("已停止");
}

// ═══════════════════════════════════════════════════════════
//  VMD 录制（照搬 plug motion-capture.tsx toggleRecording + recordFrame + createVMD）
//  30 FPS 采样，停止后自动导出 mikapo_animation.vmd，
//  frameMultiplier=2（VMD 标准 30fps，播放器多为 60fps，所以帧号×2）。
// ═══════════════════════════════════════════════════════════
function toggleRecording() {
  if (isRecording) {
    // 停止并导出
    isRecording = false;
    setBtn("btn-record", { text: "录制 VMD", removeClass: "danger", addClass: "primary" });
    setTimeout(() => {
      if (recordedFrames.length === 0) {
        setStatus("没有可导出的帧");
        return;
      }
      const blob = createVMD(recordedFrames, 2);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mikapo_animation.vmd";
      a.click();
      URL.revokeObjectURL(url);
      setStatus(`已导出 ${recordedFrames.length} 帧 VMD`);
      recordedFrames = [];
    }, 100);
  } else {
    if (!poseActive) {
      setStatus("请先启动摄像头或视频");
      return;
    }
    recordedFrames = [];
    isRecording = true;
    setBtn("btn-record", { text: "停止录制", addClass: "danger", removeClass: "primary" });
    setStatus("开始录制 VMD...");
    let lastRecordTime = performance.now();
    const targetInterval = 1000 / 30;
    const recordFrame = () => {
      if (!isRecording) return;
      const now = performance.now();
      const elapsed = now - lastRecordTime;
      if (elapsed >= targetInterval) {
        if (currentBoneStates.length > 0) {
          recordedFrames.push({
            boneStates: currentBoneStates.map((bs) => ({
              name: bs.name,
              rotation: bs.rotation.clone(),
            })),
            morphWeights: currentMorphWeights ? { ...currentMorphWeights } : null,
          });
        }
        lastRecordTime = now - (elapsed % targetInterval);
      }
      if (isRecording) requestAnimationFrame(recordFrame);
    };
    requestAnimationFrame(recordFrame);
  }
}

// VMD 文件构造（照搬 plug motion-capture.tsx createVMD）
// frameMultiplier: 1 = 30fps, 2 = 15fps effective（放慢一倍）
function createVMD(frames, frameMultiplier = 1) {
  if (frames.length === 0) return new Blob();
  function encodeShiftJIS(str) {
    const unicodeArray = Encoding.stringToCode(str);
    const sjisArray = Encoding.convert(unicodeArray, { to: "SJIS", from: "UNICODE" });
    return new Uint8Array(sjisArray);
  }
  function writeBoneFrame(dataView, offset, name, frame, position, rotation) {
    const nameBytes = encodeShiftJIS(name);
    for (let i = 0; i < 15; i++) {
      dataView.setUint8(offset + i, i < nameBytes.length ? nameBytes[i] : 0);
    }
    offset += 15;
    dataView.setUint32(offset, frame, true); offset += 4;
    dataView.setFloat32(offset, position.x, true); offset += 4;
    dataView.setFloat32(offset, position.y, true); offset += 4;
    dataView.setFloat32(offset, position.z, true); offset += 4;
    dataView.setFloat32(offset, rotation.x, true); offset += 4;
    dataView.setFloat32(offset, rotation.y, true); offset += 4;
    dataView.setFloat32(offset, rotation.z, true); offset += 4;
    dataView.setFloat32(offset, rotation.w, true); offset += 4;
    for (let i = 0; i < 64; i++) dataView.setUint8(offset + i, 20);
    offset += 64;
    return offset;
  }
  function writeMorphFrame(dataView, offset, name, frame, weight) {
    const nameBytes = encodeShiftJIS(name);
    for (let i = 0; i < 15; i++) {
      dataView.setUint8(offset + i, i < nameBytes.length ? nameBytes[i] : 0);
    }
    offset += 15;
    dataView.setUint32(offset, frame, true); offset += 4;
    dataView.setFloat32(offset, weight, true); offset += 4;
    return offset;
  }

  const frameCount = frames.length;
  const boneCnt = frames[0].boneStates.length;
  const morphNames = frames[0].morphWeights ? Object.keys(frames[0].morphWeights) : [];
  const morphCnt = morphNames.length;

  const headerSize = 30 + 20;
  const boneFrameSize = 15 + 4 + 12 + 16 + 64;
  const morphFrameSize = 15 + 4 + 4;
  const totalSize =
    headerSize + 4 + boneFrameSize * frameCount * boneCnt + 4 + morphFrameSize * frameCount * morphCnt + 4 + 4 + 4;

  const buffer = new ArrayBuffer(totalSize);
  const dataView = new DataView(buffer);
  let offset = 0;

  // Header
  const header = "Vocaloid Motion Data 0002";
  for (let i = 0; i < 30; i++) {
    dataView.setUint8(offset + i, i < header.length ? header.charCodeAt(i) : 0);
  }
  offset += 30;
  // Model name (empty)
  for (let i = 0; i < 20; i++) dataView.setUint8(offset + i, 0);
  offset += 20;
  // Bone frame count
  dataView.setUint32(offset, frameCount * boneCnt, true);
  offset += 4;
  // Bone keyframes
  for (let i = 0; i < frameCount; i++) {
    const frameNumber = i * frameMultiplier;
    for (const boneState of frames[i].boneStates) {
      offset = writeBoneFrame(
        dataView,
        offset,
        boneState.name,
        frameNumber,
        { x: 0, y: 0, z: 0 },
        boneState.rotation
      );
    }
  }
  // Morph frame count
  dataView.setUint32(offset, frameCount * morphCnt, true);
  offset += 4;
  // Morph keyframes
  for (let i = 0; i < frameCount; i++) {
    const frameNumber = i * frameMultiplier;
    const mw = frames[i].morphWeights;
    if (mw) {
      for (const morphName of morphNames) {
        offset = writeMorphFrame(dataView, offset, morphName, frameNumber, mw[morphName] ?? 0);
      }
    }
  }
  // Other counts (all 0)
  dataView.setUint32(offset, 0, true); offset += 4; // Camera
  dataView.setUint32(offset, 0, true); offset += 4; // Light
  dataView.setUint32(offset, 0, true); offset += 4; // Self shadow
  return new Blob([buffer], { type: "application/octet-stream" });
}

// ═══════════════════════════════════════════════════════════
//  事件绑定
// ═══════════════════════════════════════════════════════════
function bindEvents() {
  const bind = (id, ev, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn);
  };
  bind("btn-camera", "click", toggleCamera);
  bind("btn-record", "click", toggleRecording);
  bind("btn-model", "click", () => {
    const el = document.getElementById("model-folder-input");
    if (el) el.click();
  });
  bind("model-folder-input", "change", onPmxFolderPicked);
  bind("btn-image", "click", () => {
    const el = document.getElementById("image-input");
    if (el) el.click();
  });
  bind("image-input", "change", (e) => {
    const f = e.target.files[0];
    if (f) detectImage(f);
    e.target.value = "";
  });
  bind("btn-video", "click", () => {
    const el = document.getElementById("video-input");
    if (el) el.click();
  });
  bind("video-input", "change", (e) => {
    const f = e.target.files[0];
    if (f) detectVideo(f);
    e.target.value = "";
  });
}

// ═══════════════════════════════════════════════════════════
//  ensureUI：自包含 UI 构建
//  不依赖外部 HTML 提供任何元素——如果缺失就自己造。
//  这样不管 mikapo.js 被挂到哪个 HTML 都能跑，且不影响其他页面。
// ═══════════════════════════════════════════════════════════
function ensureUI() {
  const doc = document;
  const have = (id) => !!doc.getElementById(id);

  if (!have("mikapo-style")) {
    const style = doc.createElement("style");
    style.id = "mikapo-style";
    style.textContent = `
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 100%; height: 100%; overflow: hidden; background: #06070d; color: #fff; font-family: system-ui, sans-serif; }
      #scene-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; outline: none; }
      #ui-overlay {
        position: absolute; top: 12px; left: 12px; z-index: 10;
        background: rgba(10, 12, 20, 0.7); backdrop-filter: blur(8px);
        border: 1px solid rgba(255,255,255,0.1); border-radius: 10px;
        padding: 10px; width: 320px; max-width: calc(100vw - 24px);
      }
      .row { display: flex; gap: 6px; margin-bottom: 6px; }
      button {
        flex: 1; padding: 8px 10px; font-size: 12px; cursor: pointer;
        background: rgba(255,255,255,0.08); color: #fff; border: 1px solid rgba(255,255,255,0.15);
        border-radius: 6px; transition: background 0.15s;
      }
      button:hover:not(:disabled) { background: rgba(255,255,255,0.16); }
      button:disabled { opacity: 0.4; cursor: not-allowed; }
      button.primary { background: #2563eb; border-color: #3b82f6; }
      button.primary:hover:not(:disabled) { background: #1d4ed8; }
      button.danger { background: #dc2626; border-color: #ef4444; }
      button.danger:hover:not(:disabled) { background: #b91c1c; }
      #media-wrap {
        width: 100%; aspect-ratio: 4/3; background: #000; border-radius: 6px;
        overflow: hidden; margin-top: 6px; position: relative;
      }
      #pose-video { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); display: block; }
      #pose-image { width: 100%; height: 100%; object-fit: contain; display: none; }
      #status {
        font-size: 11px; color: rgba(255,255,255,0.7); margin-top: 6px;
        font-family: 'JetBrains Mono', monospace; min-height: 16px;
      }
      .hint { font-size: 10px; color: rgba(255,255,255,0.4); margin-top: 4px; }
      #fps { position: absolute; top: 12px; right: 12px; font-family: monospace; font-size: 11px; color: rgba(255,255,255,0.5); z-index: 10; }
    `;
    doc.head.appendChild(style);
  }

  if (!have("scene-canvas")) {
    const el = doc.createElement("canvas");
    el.id = "scene-canvas";
    doc.body.appendChild(el);
  }
  if (!have("fps")) {
    const el = doc.createElement("div");
    el.id = "fps";
    el.textContent = "— FPS";
    doc.body.appendChild(el);
  }
  if (!have("pose-video")) {
    const v = doc.createElement("video");
    v.id = "pose-video";
    v.autoplay = true; v.playsInline = true; v.muted = true;
    doc.body.appendChild(v);
  }
  if (!have("pose-image")) {
    const img = doc.createElement("img");
    img.id = "pose-image";
    img.alt = "";
    doc.body.appendChild(img);
  }
  if (!have("ui-overlay")) {
    const ov = doc.createElement("div");
    ov.id = "ui-overlay";
    ov.innerHTML = `
      <div class="row">
        <button class="primary" id="btn-camera" disabled>启动摄像头</button>
        <button id="btn-model">加载 PMX 文件夹</button>
      </div>
      <div class="row">
        <button id="btn-image" disabled>图片提取</button>
        <button id="btn-video" disabled>视频提取</button>
        <button class="primary" id="btn-record">录制 VMD</button>
      </div>
      <div id="media-wrap"></div>
      <div id="status">初始化中...</div>
      <div class="hint">默认加载 刻晴.pmx；可点"加载 PMX 文件夹"换模型</div>
    `;
    doc.body.appendChild(ov);
    const wrap = ov.querySelector("#media-wrap");
    const vid = doc.getElementById("pose-video");
    const img = doc.getElementById("pose-image");
    if (wrap && vid) wrap.appendChild(vid);
    if (wrap && img) wrap.appendChild(img);
  }
  if (!have("model-folder-input")) {
    const el = doc.createElement("input");
    el.type = "file"; el.id = "model-folder-input";
    el.setAttribute("webkitdirectory", ""); el.multiple = true;
    el.style.display = "none";
    doc.body.appendChild(el);
  }
  if (!have("image-input")) {
    const el = doc.createElement("input");
    el.type = "file"; el.id = "image-input";
    el.accept = "image/*"; el.style.display = "none";
    doc.body.appendChild(el);
  }
  if (!have("video-input")) {
    const el = doc.createElement("input");
    el.type = "file"; el.id = "video-input";
    el.accept = "video/*"; el.style.display = "none";
    doc.body.appendChild(el);
  }
}

// ═══════════════════════════════════════════════════════════
//  启动
// ═══════════════════════════════════════════════════════════
async function main() {
  ensureUI();
  bindEvents();
  await initEngine();
  try {
    await initLandmarker();
  } catch (err) {
    setStatus(`MediaPipe 初始化失败: ${err.message}`);
    console.error("[MiKaPo] MediaPipe 失败:", err);
  }
}

function bootstrap() {
  main().catch((err) => {
    console.error("[MiKaPo] main 失败:", err);
    setStatus(`启动失败: ${err.message}`);
  });
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
