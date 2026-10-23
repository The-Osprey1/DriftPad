import { DeviceConfig, KeyStatus, INITIAL_DEVICE_CONFIG, LayerKey } from '../types/driftpad';

export interface KeyDSPState {
  index: number;
  travelMm: number;
  peakDepthMm: number;
  valleyDepthMm: number;
  isPressed: boolean;
  everActuated: boolean;
  pressCount: number;
  releaseCount: number;
  restBaseline: number;
}

export class DriftPadDspEngine {
  private config: DeviceConfig;
  private keyStates: KeyDSPState[] = [];
  private lastActiveKey: number = -1;
  private isHidEnabled: boolean = false;
  private isFullScreen: boolean = true;
  private isSleeping: boolean = false;
  private screensaverActive: boolean = false;
  private forcedAnim: number = -1;
  private streaming: boolean = false;
  private streamTimer: ReturnType<typeof setInterval> | null = null;
  private onSerialOutput?: (line: string) => void;

  constructor(onSerialOutput?: (line: string) => void) {
    this.onSerialOutput = onSerialOutput;
    const saved = localStorage.getItem('driftpad_config');
    if (saved) {
      try {
        this.config = JSON.parse(saved);
      } catch {
        this.config = JSON.parse(JSON.stringify(INITIAL_DEVICE_CONFIG));
      }
    } else {
      this.config = JSON.parse(JSON.stringify(INITIAL_DEVICE_CONFIG));
    }

    this.initKeys();
  }

  public setSerialOutputCallback(cb: (line: string) => void) {
    this.onSerialOutput = cb;
  }

  private initKeys() {
    this.keyStates = [];
    for (let i = 0; i < 16; i++) {
      this.keyStates.push({
        index: i,
        travelMm: 0.0,
        peakDepthMm: 0.0,
        valleyDepthMm: 0.0,
        isPressed: false,
        everActuated: false,
        pressCount: 0,
        releaseCount: 0,
        restBaseline: 2048,
      });
    }
  }

  public getConfig(): DeviceConfig {
    return this.config;
  }

  public setConfig(cfg: DeviceConfig) {
    this.config = cfg;
    this.saveConfigToStorage();
  }

  public dispose() {
    this.stopStreaming();
  }

  public getKeysStatus(): KeyStatus[] {
    const activeLayer = this.config.active_layer;
    const currentLayerKeys = this.config.layers[activeLayer] || [];

    return this.keyStates.map((k) => {
      const keyDef = currentLayerKeys[k.index];
      return {
        idx: k.index,
        pressed: k.isPressed,
        travel: Number(k.travelMm.toFixed(2)),
        label: keyDef?.label || `K${k.index}`,
        peakDepth: k.peakDepthMm,
        valleyDepth: k.valleyDepthMm,
        customActuation: keyDef?.customActuation,
        pressCount: k.pressCount,
      };
    });
  }

  public getLastActiveKey(): number {
    return this.lastActiveKey;
  }

  public isHidActive(): boolean {
    return this.isHidEnabled;
  }

  public getFullScreen(): boolean {
    return this.isFullScreen;
  }

  public isDisplaySleeping(): boolean {
    return this.isSleeping;
  }

  public isScreensaverActive(): boolean {
    return this.screensaverActive;
  }

  public getForcedAnim(): number {
    return this.forcedAnim;
  }

  /**
   * Rapid Trigger Hall-Effect DSP core update with per-key custom actuation support
   */
  public injectTravel(keyIdx: number, travelMm: number): { pressed: boolean; travel: number } {
    if (keyIdx < 0 || keyIdx >= 16) return { pressed: false, travel: 0 };
    const k = this.keyStates[keyIdx];
    this.lastActiveKey = keyIdx;

    if (this.isSleeping) {
      this.isSleeping = false;
    }
    if (this.screensaverActive) {
      this.screensaverActive = false;
    }

    const clamped = Math.max(0.0, Math.min(4.0, travelMm));
    k.travelMm = clamped;

    const activeLayer = this.config.active_layer;
    const keyDef = this.config.layers[activeLayer]?.[keyIdx];
    // Check if this key has a custom safety actuation point override
    const actuation =
      keyDef?.customActuation !== undefined ? keyDef.customActuation : this.config.actuation;

    const rtSens = this.config.rt_sens;
    const rtEnabled = this.config.rt_enabled;
    const wasPressed = k.isPressed;

    if (!rtEnabled) {
      // Standard fixed actuation with 0.08mm hysteresis
      const resetThreshold = Math.max(0.05, actuation - 0.08);
      if (!k.isPressed) {
        if (clamped >= actuation) {
          k.isPressed = true;
          k.pressCount++;
        }
      } else {
        if (clamped <= resetThreshold) {
          k.isPressed = false;
          k.releaseCount++;
        }
      }
    } else {
      // Rapid Trigger mode
      if (!k.isPressed) {
        if (clamped >= actuation && !k.everActuated) {
          k.isPressed = true;
          k.everActuated = true;
          k.peakDepthMm = clamped;
          k.valleyDepthMm = clamped;
          k.pressCount++;
        } else if (k.everActuated) {
          if (clamped < k.valleyDepthMm) {
            k.valleyDepthMm = clamped;
          }
          if (clamped >= k.valleyDepthMm + rtSens && clamped >= actuation) {
            k.isPressed = true;
            k.peakDepthMm = clamped;
            k.pressCount++;
          }
          if (clamped <= 0.05) {
            k.everActuated = false;
            k.valleyDepthMm = 0.0;
            k.peakDepthMm = 0.0;
          }
        }
      } else {
        if (clamped > k.peakDepthMm) {
          k.peakDepthMm = clamped;
        }

        if (clamped <= k.peakDepthMm - rtSens || clamped <= 0.05) {
          k.isPressed = false;
          k.valleyDepthMm = clamped;
          k.releaseCount++;
        }
      }
    }

    if (wasPressed !== k.isPressed && this.onSerialOutput) {
      this.onSerialOutput(
        JSON.stringify({
          type: 'sim_event',
          key: keyIdx,
          travel: clamped.toFixed(2),
          pressed: k.isPressed,
        })
      );
    }

    return { pressed: k.isPressed, travel: clamped };
  }

  /**
   * Process a serial line command
   */
  public processCommand(rawLine: string): string {
    const line = rawLine.trim();
    if (!line) return '';

    if (
      !line.toUpperCase().startsWith('SLEEP') &&
      !line.toUpperCase().startsWith('SCREENSAVER') &&
      !line.toUpperCase().startsWith('ANIM')
    ) {
      this.isSleeping = false;
      this.screensaverActive = false;
    }

    const upper = line.toUpperCase();

    if (upper === 'PING') {
      const resp = JSON.stringify({ type: 'pong' });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper === 'GET_CONFIG') {
      const resp = JSON.stringify({
        type: 'config',
        actuation: this.config.actuation,
        rt_sens: this.config.rt_sens,
        rt_enabled: this.config.rt_enabled,
        active_layer: this.config.active_layer,
        layers: this.config.layers,
      });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper === 'STATUS') {
      const resp = JSON.stringify({
        type: 'status',
        active_layer: this.config.active_layer,
        last_key: this.lastActiveKey,
        keys: this.getKeysStatus(),
      });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper.startsWith('SET_ACTUATION ')) {
      const val = parseFloat(line.substring(14));
      if (!isNaN(val) && val >= 0.1 && val <= 3.8) {
        this.config.actuation = Number(val.toFixed(2));
        this.saveConfigToStorage();
        const resp = JSON.stringify({
          status: 'ok',
          msg: `Actuation set to ${this.config.actuation.toFixed(2)} mm`,
        });
        this.onSerialOutput?.(resp);
        return resp;
      }
      const err = JSON.stringify({ status: 'error', msg: 'Invalid actuation (0.1 - 3.8mm)' });
      this.onSerialOutput?.(err);
      return err;
    }

    if (upper.startsWith('SET_RT_SENS ')) {
      const val = parseFloat(line.substring(12));
      if (!isNaN(val) && val >= 0.1 && val <= 2.0) {
        this.config.rt_sens = Number(val.toFixed(2));
        this.saveConfigToStorage();
        const resp = JSON.stringify({
          status: 'ok',
          msg: `RT sensitivity set to ${this.config.rt_sens.toFixed(2)} mm`,
        });
        this.onSerialOutput?.(resp);
        return resp;
      }
      const err = JSON.stringify({ status: 'error', msg: 'Invalid RT sensitivity (0.10 - 2.0mm)' });
      this.onSerialOutput?.(err);
      return err;
    }

    if (upper.startsWith('SET_RT_ENABLE ')) {
      const val = parseInt(line.substring(14), 10);
      const en = val !== 0;
      this.config.rt_enabled = en;
      this.saveConfigToStorage();
      const resp = JSON.stringify({
        status: 'ok',
        msg: `Rapid Trigger ${en ? 'ENABLED' : 'DISABLED'}`,
      });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper.startsWith('SET_LAYER ')) {
      const l = parseInt(line.substring(10), 10);
      if (l >= 0 && l < 3) {
        this.config.active_layer = l;
        this.saveConfigToStorage();
        const resp = JSON.stringify({ status: 'ok', msg: `Active layer set to ${l}` });
        this.onSerialOutput?.(resp);
        return resp;
      }
      const err = JSON.stringify({ status: 'error', msg: 'Invalid layer index' });
      this.onSerialOutput?.(err);
      return err;
    }

    if (upper.startsWith('SET_KEY ')) {
      const parts = line.split(/\s+/);
      if (parts.length >= 4) {
        const layer = parseInt(parts[1], 10);
        const keyIdx = parseInt(parts[2], 10);
        const hidCode = parseInt(parts[3], 10);
        const label = (parts[4] || 'KEY').slice(0, 4).toUpperCase();

        if (
          layer >= 0 &&
          layer < 3 &&
          keyIdx >= 0 &&
          keyIdx < 16 &&
          hidCode >= 0 &&
          hidCode <= 255
        ) {
          if (!this.config.layers[layer]) {
            this.config.layers[layer] = [];
          }
          const existing = this.config.layers[layer][keyIdx];
          this.config.layers[layer][keyIdx] = {
            ...existing,
            idx: keyIdx,
            code: hidCode,
            label,
          };
          this.saveConfigToStorage();
          const resp = JSON.stringify({
            status: 'ok',
            msg: `Key L${layer}:K${keyIdx} updated to [${label}] code ${hidCode}`,
          });
          this.onSerialOutput?.(resp);
          return resp;
        }
      }
      const err = JSON.stringify({ status: 'error', msg: 'Invalid key update arguments' });
      this.onSerialOutput?.(err);
      return err;
    }

    if (upper.startsWith('SIM ')) {
      const parts = line.split(/\s+/);
      if (parts.length >= 3) {
        const keyIdx = parseInt(parts[1], 10);
        const travel = parseFloat(parts[2]);
        if (keyIdx >= 0 && keyIdx < 16 && !isNaN(travel)) {
          const res = this.injectTravel(keyIdx, travel);
          const resp = JSON.stringify({
            type: 'sim_event',
            key: keyIdx,
            travel: res.travel.toFixed(2),
            pressed: res.pressed,
          });
          this.onSerialOutput?.(resp);
          return resp;
        }
      }
    }

    if (upper.startsWith('STREAM ')) {
      const en = parseInt(line.substring(7), 10) !== 0;
      if (en) {
        this.startStreaming();
      } else {
        this.stopStreaming();
      }
      const resp = JSON.stringify({ status: 'ok', streaming: this.streaming });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper === 'SAVE') {
      this.saveConfigToStorage();
      const resp = JSON.stringify({ status: 'ok', msg: 'Settings saved to Flash' });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper === 'RESET') {
      this.stopStreaming();
      this.config = JSON.parse(JSON.stringify(INITIAL_DEVICE_CONFIG));
      this.saveConfigToStorage();
      this.initKeys();
      const resp = JSON.stringify({ status: 'ok', msg: 'Factory reset complete' });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper === 'CALIBRATE') {
      for (const k of this.keyStates) {
        k.restBaseline = 2048;
        k.travelMm = 0.0;
        k.isPressed = false;
        k.everActuated = false;
      }
      const resp = JSON.stringify({
        status: 'ok',
        msg: 'Rest baselines calibrated and saved to Flash',
      });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper.startsWith('FULLSCREEN')) {
      const parts = line.split(/\s+/);
      if (parts.length > 1) {
        this.isFullScreen = parts[1] === '1' || parts[1].toLowerCase() === 'true';
      } else {
        this.isFullScreen = !this.isFullScreen;
      }
      const resp = JSON.stringify({ status: 'ok', fullscreen: this.isFullScreen });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper === 'SCREENSAVER') {
      this.screensaverActive = true;
      const resp = JSON.stringify({ status: 'ok', screensaver: true });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper.startsWith('ANIM')) {
      const parts = line.split(/\s+/);
      const idx = parts.length > 1 ? parseInt(parts[1], 10) : -1;
      this.forcedAnim = idx;
      this.screensaverActive = true;
      const resp = JSON.stringify({ status: 'ok', anim: idx });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper === 'SLEEP') {
      this.isSleeping = true;
      const resp = JSON.stringify({ status: 'ok', sleep: true });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper === 'WAKE') {
      this.isSleeping = false;
      const resp = JSON.stringify({ status: 'ok', wake: true });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper === 'OLED_SCAN') {
      const resp = JSON.stringify({ status: 'ok', msg: 'I2C scan: SSD1306 found at 0x3C' });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper === 'OLED_TEST') {
      const resp = JSON.stringify({ status: 'ok', msg: 'Drawing SSD1306 checkerboard test pattern' });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper === 'BOOTSEL') {
      const resp = JSON.stringify({ status: 'ok', bootsel: true });
      this.onSerialOutput?.(resp);
      return resp;
    }

    if (upper.startsWith('SET_HID ') || upper.startsWith('HID ')) {
      const space = line.indexOf(' ');
      const val = parseInt(line.substring(space + 1), 10);
      this.isHidEnabled = val !== 0;
      const resp = JSON.stringify({ status: 'ok', hid_output: this.isHidEnabled });
      this.onSerialOutput?.(resp);
      return resp;
    }

    const unknown = JSON.stringify({ status: 'error', msg: `Unknown command: ${line}` });
    this.onSerialOutput?.(unknown);
    return unknown;
  }

  private saveConfigToStorage() {
    try {
      localStorage.setItem('driftpad_config', JSON.stringify(this.config));
    } catch {
      // storage unavailable
    }
  }

  private startStreaming() {
    if (this.streaming) return;
    this.streaming = true;
    this.streamTimer = setInterval(() => {
      this.onSerialOutput?.(
        JSON.stringify({
          type: 'status',
          active_layer: this.config.active_layer,
          last_key: this.lastActiveKey,
          keys: this.getKeysStatus(),
        })
      );
    }, 33);
  }

  private stopStreaming() {
    this.streaming = false;
    if (this.streamTimer) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }
  }

  public updateKey(layer: number, keyIdx: number, updated: LayerKey) {
    if (this.config.layers[layer]) {
      this.config.layers[layer][keyIdx] = updated;
      this.saveConfigToStorage();
    }
  }
}
