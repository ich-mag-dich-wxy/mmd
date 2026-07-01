// ═══════════════════════════════════════════════════════════
//  独立动捕系统 — 照搬 MiKaPo 的 MediaPipe Holistic 初始化
//
//  支持三种输入模式：
//    1. 摄像头实时捕获
//    2. 图片提取姿势（单帧）
//    3. 视频提取动作（连续帧）
//
//  完全独立于 UI 框架，只提供 API
// ═══════════════════════════════════════════════════════════

import { FilesetResolver, HolisticLandmarker } from '@mediapipe/tasks-vision';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task';

let _landmarker = null;
let _initPromise = null;

/**
 * 初始化 HolisticLandmarker（单例）
 * @param {function(string): void} onStatus - 状态回调
 * @returns {Promise<HolisticLandmarker>}
 */
export async function initHolisticLandmarker(onStatus) {
  if (_landmarker) return _landmarker;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    if (onStatus) onStatus('加载 WASM...');
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);

    const createOptions = {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: 'GPU',
      },
      minPosePresenceConfidence: 0.7,
      minPoseDetectionConfidence: 0.7,
      minFaceDetectionConfidence: 0.4,
      minHandLandmarksConfidence: 0.95,
      runningMode: 'VIDEO',
    };

    if (onStatus) onStatus('加载 Holistic 检测模型...');
    try {
      _landmarker = await HolisticLandmarker.createFromOptions(vision, createOptions);
    } catch (gpuError) {
      console.warn('[Holistic] GPU 失败，回退到 CPU:', gpuError);
      _landmarker = await HolisticLandmarker.createFromOptions(vision, {
        ...createOptions,
        baseOptions: { ...createOptions.baseOptions, delegate: 'CPU' },
      });
    }

    // 预热（触发 GPU shader 编译）
    if (onStatus) onStatus('预热模型...');
    try {
      const warmupCanvas = document.createElement('canvas');
      warmupCanvas.width = 256;
      warmupCanvas.height = 256;
      const ctx = warmupCanvas.getContext('2d');
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, 256, 256);
      _landmarker.detectForVideo(warmupCanvas, performance.now());
    } catch (e) {
      // 预热失败忽略
    }

    if (onStatus) onStatus('Holistic 初始化完成');
    return _landmarker;
  })();

  return _initPromise;
}

/**
 * 动捕系统类
 * 支持摄像头、图片、视频三种输入
 */
export class PoseCaptureSystem {
  constructor() {
    this.landmarker = null;
    this.videoEl = null;
    this.imageEl = null;
    this.stream = null;
    this.running = false;
    this.mode = null; // 'camera' | 'image' | 'video'
    this.lastTime = 0;
    this.lastImgSrc = '';
    this.frameCounter = 0;
    this.FRAME_SKIP = 2; // 每 2 帧处理一次
    this.onResult = null;
    this._rafId = null;
  }

  /**
   * 初始化
   * @param {function(string): void} onStatus
   */
  async init(onStatus) {
    this.landmarker = await initHolisticLandmarker(onStatus);
    return this;
  }

  /**
   * 启动摄像头捕获
   * @param {HTMLVideoElement} videoEl
   * @param {function(Object): void} onResult - 检测结果回调
   * @param {function(string): void} onStatus
   */
  async startCamera(videoEl, onResult, onStatus) {
    if (onStatus) onStatus('打开摄像头...');
    this.stop();
    this.videoEl = videoEl;
    this.onResult = onResult;
    this.mode = 'camera';

    // 确保是 VIDEO 模式
    if (this.landmarker.runningMode !== 'VIDEO') {
      await this.landmarker.setOptions({ runningMode: 'VIDEO' });
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
    });
    videoEl.srcObject = this.stream;
    await videoEl.play();

    this.running = true;
    if (onStatus) onStatus('摄像头已启动');
    this._detect();
  }

  /**
   * 从图片提取姿势
   * @param {HTMLImageElement} imageEl
   * @param {string} imageUrl
   * @param {function(Object): void} onResult
   * @param {function(string): void} onStatus
   */
  async detectImage(imageEl, imageUrl, onResult, onStatus) {
    if (onStatus) onStatus('切换到图片模式...');
    this.stop();

    // 切换到 IMAGE 模式
    await this.landmarker.setOptions({ runningMode: 'IMAGE' });
    this.mode = 'image';
    this.imageEl = imageEl;
    this.onResult = onResult;

    if (onStatus) onStatus('加载图片...');
    imageEl.src = imageUrl;
    await new Promise((resolve) => {
      imageEl.onload = resolve;
      imageEl.onerror = resolve;
    });

    if (onStatus) onStatus('检测姿势...');
    const result = this.landmarker.detect(imageEl);
    if (result && result.poseWorldLandmarks && result.poseWorldLandmarks.length > 0) {
      onResult(this._formatResult(result));
      if (onStatus) onStatus('姿势提取完成');
    } else {
      if (onStatus) onStatus('未检测到姿势');
    }
  }

  /**
   * 从视频提取动作
   * @param {HTMLVideoElement} videoEl
   * @param {string} videoUrl
   * @param {function(Object): void} onResult - 每帧检测结果
   * @param {function(string): void} onStatus
   * @param {function(): void} onComplete - 视频播放完成
   */
  async detectVideo(videoEl, videoUrl, onResult, onStatus, onComplete) {
    if (onStatus) onStatus('切换到视频模式...');
    this.stop();

    // 切换到 VIDEO 模式
    await this.landmarker.setOptions({ runningMode: 'VIDEO' });
    this.mode = 'video';
    this.videoEl = videoEl;
    this.onResult = onResult;
    this._onComplete = onComplete;

    if (onStatus) onStatus('加载视频...');
    videoEl.src = videoUrl;
    videoEl.currentTime = 0;

    await new Promise((resolve) => {
      videoEl.onloadedmetadata = resolve;
    });

    if (onStatus) onStatus('开始提取动作...');
    this.running = true;
    await videoEl.play();
    this._detect();
  }

  /**
   * 检测循环
   */
  _detect() {
    if (!this.running) return;

    if (this.mode === 'camera' || this.mode === 'video') {
      if (this.videoEl && this.videoEl.readyState >= 2 && this.videoEl.videoWidth > 0) {
        const now = performance.now();
        if (this.videoEl.currentTime !== this.lastTime) {
          this.lastTime = this.videoEl.currentTime;
          this.frameCounter++;

          if (this.frameCounter % this.FRAME_SKIP === 0) {
            try {
              const result = this.landmarker.detectForVideo(this.videoEl, Math.floor(now));
              if (result && result.poseWorldLandmarks && result.poseWorldLandmarks.length > 0) {
                if (this.onResult) this.onResult(this._formatResult(result));
              }
            } catch (e) {
              // 检测错误忽略
            }
          }
        }

        // 视频模式检测是否结束
        if (this.mode === 'video' && this.videoEl.ended) {
          this.running = false;
          if (this._onComplete) this._onComplete();
          return;
        }
      }
    }

    this._rafId = requestAnimationFrame(() => this._detect());
  }

  /**
   * 格式化检测结果（保持与 MiKaPo 一致的数据结构）
   */
  _formatResult(result) {
    return {
      poseWorldLandmarks: result.poseWorldLandmarks || [],
      poseLandmarks: result.poseLandmarks || [],
      faceLandmarks: result.faceLandmarks || [],
      leftHandWorldLandmarks: result.leftHandWorldLandmarks || [],
      rightHandWorldLandmarks: result.rightHandWorldLandmarks || [],
      leftHandLandmarks: result.leftHandLandmarks || [],
      rightHandLandmarks: result.rightHandLandmarks || [],
    };
  }

  /**
   * 停止检测
   */
  stop() {
    this.running = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.srcObject = null;
    }
    this.mode = null;
  }

  /**
   * 销毁
   */
  destroy() {
    this.stop();
    this.landmarker = null;
  }
}
