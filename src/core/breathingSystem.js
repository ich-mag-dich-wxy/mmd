export class BreathingSystem {
  constructor() {
    this._time = 0;
    this._baseRate = 0.28;
    this._rate = 0.28;
    this._targetRate = 0.28;
    this._amplitude = 0.012;
    this._targetAmplitude = 0.012;
    this.chest = 0;
    this.belly = 0;
    this.shoulderLift = 0;
  }

  setEnergy(e) {
    const clamped = Math.max(0.05, Math.min(1, e));
    this._targetRate = this._baseRate + clamped * 0.2;
    this._targetAmplitude = 0.008 + clamped * 0.025;
  }

  setEmotion(emotion) {
    const stress = (emotion.angry || 0) * 0.7 + (emotion.sad || 0) * 0.3;
    if (stress > 0.3) {
      this._targetRate += stress * 0.08;
    }
  }

  update(dt) {
    this._rate += (this._targetRate - this._rate) * Math.min(1, dt * 3);
    this._amplitude += (this._targetAmplitude - this._amplitude) * Math.min(1, dt * 4);

    this._time += dt * Math.PI * 2 * this._rate;
    if (this._time > Math.PI * 2) this._time -= Math.PI * 2;

    const raw = Math.sin(this._time);
    this.chest = raw * this._amplitude;
    this.belly = raw * this._amplitude * 1.3;
    this.shoulderLift = Math.max(0, raw) * this._amplitude * 2.5;
  }
}
