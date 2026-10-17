import React, { useEffect, useRef, useState } from 'react';
import {
  KeyStatus,
  OledThemeConfig,
  DEFAULT_OLED_THEME,
  OledWidgetMode,
  OledCustomBitmap,
} from '../types/driftpad';
import {
  Sparkles,
  Monitor,
  Moon,
  Eye,
  RefreshCw,
  Gauge,
  LayoutGrid,
  Clock,
  Paintbrush,
  Briefcase,
} from 'lucide-react';

interface OledCanvasProps {
  keys: KeyStatus[];
  actuation: number;
  rtSens: number;
  rtEnabled: boolean;
  profileName: string;
  knobName: string;
  lastActiveKey: number;
  lastActiveKeyTime: number;
  theme?: OledThemeConfig;
  isSleeping?: boolean;
  screensaverActive?: boolean;
  forcedAnim?: number;
  totalKeystrokes?: number;
  apm?: number;
  cps?: number;
  customBitmap?: OledCustomBitmap | null;
  onOpenThemeModal?: () => void;
  onOpenPixelEditor?: () => void;
  onSendSerialCommand?: (cmd: string) => void;
}

export type ScreensaverAnimation = 0 | 1 | 2 | 3 | 4 | 5;

const SCREENSAVER_NAMES: Record<ScreensaverAnimation, string> = {
  0: 'Starfield 3D',
  1: 'Matrix Rain',
  2: 'DVD Bounce',
  3: 'Sine Wave',
  4: 'Pixel Dust',
  5: 'Clock HUD',
};

export const OledCanvas: React.FC<OledCanvasProps> = ({
  keys,
  actuation,
  rtSens,
  rtEnabled,
  profileName,
  knobName,
  lastActiveKey,
  lastActiveKeyTime: _lastActiveKeyTime,
  theme,
  isSleeping = false,
  screensaverActive = false,
  forcedAnim = -1,
  totalKeystrokes = 0,
  apm = 0,
  cps = 0,
  customBitmap = null,
  onOpenThemeModal,
  onOpenPixelEditor,
  onSendSerialCommand,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewMode, setViewMode] = useState<OledWidgetMode>('cockpit');
  const [selectedAnim, setSelectedAnim] = useState<ScreensaverAnimation>(0);

  // Timer Widget state
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(25 * 60);

  // State refs for animation loops without re-triggering useEffect
  const stateRef = useRef({
    time: 0,
    // Starfield
    stars: Array.from({ length: 48 }, () => ({
      x: (Math.random() - 0.5) * 128,
      y: (Math.random() - 0.5) * 64,
      z: Math.random() * 128 + 1,
    })),
    // Matrix Rain
    matrixDrops: Array.from({ length: 16 }, () => Math.floor(Math.random() * 64)),
    // DVD Bounce
    dvd: { x: 10, y: 10, vx: 1.2, vy: 0.9, w: 28, h: 12 },
  });

  const animFrameRef = useRef<number | null>(null);

  // Focus timer tick
  useEffect(() => {
    if (!timerRunning) return;
    const interval = setInterval(() => {
      setTimerSeconds((prev) => (prev > 0 ? prev - 1 : 25 * 60));
    }, 1000);
    return () => clearInterval(interval);
  }, [timerRunning]);

  useEffect(() => {
    if (screensaverActive) {
      setViewMode('screensaver');
    }
  }, [screensaverActive]);

  useEffect(() => {
    if (forcedAnim >= 0 && forcedAnim <= 5) {
      setSelectedAnim(forcedAnim as ScreensaverAnimation);
      setViewMode('screensaver');
    }
  }, [forcedAnim]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = 128;
    const H = 64;

    // Single-Color Monochrome White OLED (SSD1306 hardware match)
    const activeTheme = theme || DEFAULT_OLED_THEME;
    const primaryColor = activeTheme.textColor || '#ffffff';
    const bgColor = activeTheme.background || '#04070a';
    const graphColor = activeTheme.graphColor || '#ffffff';
    const dimColor = activeTheme.dimColor || '#283238';
    const accentColor = activeTheme.accentColor || '#ffffff';

    const render = () => {
      stateRef.current.time += 1;
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, W, H);

      if (isSleeping) {
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      if (viewMode === 'test') {
        renderTestPattern(ctx, W, H);
      } else if (viewMode === 'screensaver') {
        renderScreensaver(ctx, W, H, selectedAnim);
      } else if (viewMode === 'speedometer') {
        renderSpeedometer(ctx, W, H);
      } else if (viewMode === 'heatmap') {
        renderHeatmap(ctx, W, H);
      } else if (viewMode === 'timer') {
        renderTimer(ctx, W, H);
      } else if (viewMode === 'custom') {
        renderCustomBitmap(ctx, W, H);
      } else {
        renderCockpit(ctx, W, H);
      }

      animFrameRef.current = requestAnimationFrame(render);
    };

    const renderCockpit = (c: CanvasRenderingContext2D, w: number, _h: number) => {
      // Top status line
      c.fillStyle = primaryColor;
      c.font = 'bold 7px monospace';
      c.fillText(profileName.slice(0, 14).toUpperCase(), 2, 8);

      // Inverted 16-KEY badge
      c.fillStyle = primaryColor;
      c.fillRect(90, 1, 36, 9);
      c.fillStyle = bgColor;
      c.fillText('16-KEY', 94, 8);
      c.fillStyle = primaryColor;

      // Divider line
      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 11);
      c.lineTo(w, 11);
      c.stroke();

      // Active Key Box
      const activeKeyObj = keys[lastActiveKey >= 0 ? lastActiveKey : 0] || {
        idx: 0,
        pressed: false,
        travel: 0.0,
        label: 'KEY',
      };
      const isActuated = activeKeyObj.pressed;

      if (isActuated) {
        c.fillStyle = accentColor;
        c.fillRect(3, 14, 34, 34);
        c.fillStyle = bgColor;
      } else {
        c.strokeStyle = graphColor;
        c.strokeRect(3, 14, 34, 34);
        c.fillStyle = primaryColor;
      }

      c.font = 'bold 11px monospace';
      c.textAlign = 'center';
      c.fillText(activeKeyObj.label, 20, 31);
      c.font = '6px monospace';
      c.fillText(`#${activeKeyObj.idx}`, 20, 43);
      c.textAlign = 'left';

      // Dial readout
      c.fillStyle = primaryColor;
      c.font = '6px monospace';
      c.fillText(`DIAL: ${knobName.slice(0, 13).toUpperCase()}`, 42, 21);

      // Travel reading
      c.font = 'bold 8px monospace';
      c.fillText(`${activeKeyObj.travel.toFixed(2)}mm`, 42, 32);

      c.font = '6px monospace';
      c.fillStyle = isActuated ? accentColor : dimColor;
      c.fillText(isActuated ? 'ACTUATED' : 'IDLE REST', 86, 32);

      // Analog Travel Bar
      const trackX = 42;
      const trackY = 36;
      const trackW = 82;
      const trackH = 8;
      c.strokeStyle = dimColor;
      c.strokeRect(trackX, trackY, trackW, trackH);

      const fillW = Math.max(0, Math.min(trackW, (activeKeyObj.travel / 4.0) * trackW));
      c.fillStyle = primaryColor;
      c.fillRect(trackX + 1, trackY + 1, fillW, trackH - 2);

      // Actuation Line
      const effAct = activeKeyObj.customActuation ?? actuation;
      const actX = trackX + (effAct / 4.0) * trackW;
      c.strokeStyle = primaryColor;
      c.beginPath();
      c.moveTo(actX, trackY - 2);
      c.lineTo(actX, trackY + trackH + 2);
      c.stroke();

      // Bottom Telemetry Bar
      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 52);
      c.lineTo(w, 52);
      c.stroke();

      c.fillStyle = primaryColor;
      c.font = '6px monospace';
      c.fillText(`ACT:${actuation.toFixed(2)}mm`, 2, 60);
      c.fillText(`RT:${rtSens.toFixed(2)}mm`, 50, 60);
      c.fillText(rtEnabled ? 'RT:ON' : 'RT:OFF', 98, 60);
    };

    const renderSpeedometer = (c: CanvasRenderingContext2D, w: number, _h: number) => {
      // Header
      c.fillStyle = primaryColor;
      c.font = 'bold 7px monospace';
      c.fillText('METRICS HUD · APM', 2, 8);

      c.fillStyle = primaryColor;
      c.fillRect(86, 1, 40, 9);
      c.fillStyle = bgColor;
      c.fillText(`${cps.toFixed(1)} CPS`, 90, 8);

      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 11);
      c.lineTo(w, 11);
      c.stroke();

      // Big APM Value
      c.fillStyle = primaryColor;
      c.font = 'bold 18px monospace';
      c.fillText(`${Math.round(apm)}`, 6, 32);

      c.font = '6px monospace';
      c.fillStyle = dimColor;
      c.fillText('APM SPEED', 6, 41);

      // Gauge Arc on right
      const centerX = 94;
      const centerY = 33;
      const radius = 18;

      // Arc background
      c.strokeStyle = dimColor;
      c.lineWidth = 3;
      c.beginPath();
      c.arc(centerX, centerY, radius, Math.PI * 0.8, Math.PI * 2.2);
      c.stroke();

      // Arc progress
      const progress = Math.min(1, apm / 350);
      c.strokeStyle = primaryColor;
      c.beginPath();
      c.arc(centerX, centerY, radius, Math.PI * 0.8, Math.PI * (0.8 + 1.4 * progress));
      c.stroke();
      c.lineWidth = 1;

      // Needle / Center dot
      c.fillStyle = primaryColor;
      c.beginPath();
      c.arc(centerX, centerY, 2.5, 0, Math.PI * 2);
      c.fill();

      // Bottom bar: Keystrokes & Effort
      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 52);
      c.lineTo(w, 52);
      c.stroke();

      c.fillStyle = primaryColor;
      c.font = '6px monospace';
      c.fillText(`TOTAL: ${totalKeystrokes} KEYS`, 4, 60);
      c.fillText(`EFFORT: ${Math.round(progress * 100)}%`, 75, 60);
    };

    const renderHeatmap = (c: CanvasRenderingContext2D, w: number, _h: number) => {
      // Header
      c.fillStyle = primaryColor;
      c.font = 'bold 7px monospace';
      c.fillText('4x4 MATRIX SENSOR MAP', 2, 8);

      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 11);
      c.lineTo(w, 11);
      c.stroke();

      // 4x4 Grid in center
      const startX = 14;
      const startY = 14;
      const keyW = 14;
      const keyH = 8;
      const gap = 2;

      for (let r = 0; r < 4; r++) {
        for (let col = 0; col < 4; col++) {
          const idx = r * 4 + col;
          const k = keys[idx] || { pressed: false, travel: 0, label: `${idx}` };
          const x = startX + col * (keyW + gap);
          const y = startY + r * (keyH + gap);

          if (k.pressed) {
            c.fillStyle = primaryColor;
            c.fillRect(x, y, keyW, keyH);
            c.fillStyle = bgColor;
            c.font = 'bold 5px monospace';
            c.fillText(k.label.slice(0, 3), x + 1, y + 6);
          } else {
            c.strokeStyle = dimColor;
            c.strokeRect(x, y, keyW, keyH);

            // Inner travel bar proportional to magnetic depth
            if (k.travel > 0.05) {
              const fill = Math.min(keyW - 2, (k.travel / 4.0) * (keyW - 2));
              c.fillStyle = primaryColor;
              c.fillRect(x + 1, y + keyH - 3, fill, 2);
            }

            c.fillStyle = primaryColor;
            c.font = '5px monospace';
            c.fillText(k.label.slice(0, 3), x + 1, y + 6);
          }
        }
      }

      // Live readout on right side
      const activeObj = keys[lastActiveKey >= 0 ? lastActiveKey : 0] || keys[0];
      c.fillStyle = primaryColor;
      c.font = 'bold 7px monospace';
      c.fillText(`KEY #${activeObj?.idx ?? 0}`, 80, 24);
      c.font = '6px monospace';
      c.fillText(activeObj?.label ?? 'NONE', 80, 34);
      c.fillText(`${(activeObj?.travel ?? 0).toFixed(2)}mm`, 80, 44);

      // Footer
      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 53);
      c.lineTo(w, 53);
      c.stroke();

      c.fillStyle = primaryColor;
      c.font = '5px monospace';
      c.fillText('HALL SENSORS · 0.00-4.00mm CONTINUOUS', 4, 61);
    };

    const renderTimer = (c: CanvasRenderingContext2D, w: number, _h: number) => {
      // Header
      c.fillStyle = primaryColor;
      c.font = 'bold 7px monospace';
      c.fillText('FOCUS POMODORO TIMER', 2, 8);

      c.fillStyle = primaryColor;
      c.fillRect(84, 1, 42, 9);
      c.fillStyle = bgColor;
      c.fillText(timerRunning ? 'RUNNING' : 'PAUSED', 88, 8);

      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 11);
      c.lineTo(w, 11);
      c.stroke();

      // Big digital clock
      const mins = Math.floor(timerSeconds / 60);
      const secs = timerSeconds % 60;
      const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

      c.fillStyle = primaryColor;
      c.font = 'bold 22px monospace';
      c.textAlign = 'center';
      c.fillText(timeStr, 64, 38);
      c.textAlign = 'left';

      // Progress bar
      const totalSec = 25 * 60;
      const elapsed = totalSec - timerSeconds;
      const barW = 100;
      const fillW = (elapsed / totalSec) * barW;
      const barX = 14;
      const barY = 44;

      c.strokeStyle = dimColor;
      c.strokeRect(barX, barY, barW, 5);
      c.fillStyle = primaryColor;
      c.fillRect(barX + 1, barY + 1, fillW, 3);

      // Footer
      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 53);
      c.lineTo(w, 53);
      c.stroke();

      c.fillStyle = primaryColor;
      c.font = '6px monospace';
      c.fillText('KNOB CLICK TO PLAY/PAUSE', 14, 61);
    };

    const renderCustomBitmap = (c: CanvasRenderingContext2D, w: number, _h: number) => {
      // Header
      c.fillStyle = primaryColor;
      c.font = 'bold 7px monospace';
      const title = customBitmap?.name ? customBitmap.name.slice(0, 16) : 'CUSTOM LOGO';
      c.fillText(title.toUpperCase(), 2, 8);

      c.fillStyle = primaryColor;
      c.fillRect(90, 1, 36, 9);
      c.fillStyle = bgColor;
      c.fillText('BITMAP', 94, 8);

      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 11);
      c.lineTo(w, 11);
      c.stroke();

      // Draw custom bitmap centered or render default
      if (customBitmap?.data && customBitmap.data.length === 32 * 32) {
        const offX = 48;
        const offY = 16;
        c.fillStyle = primaryColor;
        for (let py = 0; py < 32; py++) {
          for (let px = 0; px < 32; px++) {
            if (customBitmap.data[py * 32 + px] === 1) {
              c.fillRect(offX + px, offY + py, 1, 1);
            }
          }
        }
      } else {
        // Fallback DP emblem
        c.fillStyle = primaryColor;
        c.font = 'bold 16px monospace';
        c.textAlign = 'center';
        c.fillText('DRIFTPAD', 64, 34);
        c.font = '6px monospace';
        c.fillText('0.96" SSD1306 WHITE OLED', 64, 44);
        c.textAlign = 'left';
      }

      // Footer
      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 53);
      c.lineTo(w, 53);
      c.stroke();

      c.fillStyle = primaryColor;
      c.font = '6px monospace';
      c.fillText('CLICK [EDIT GRAPHIC] TO DRAW', 6, 61);
    };

    const renderScreensaver = (c: CanvasRenderingContext2D, w: number, h: number, anim: ScreensaverAnimation) => {
      c.fillStyle = bgColor;
      c.fillRect(0, 0, w, h);

      if (anim === 0) {
        // 3D Starfield
        const cx = w / 2;
        const cy = h / 2;
        stateRef.current.stars.forEach((s) => {
          s.z -= 1.5;
          if (s.z <= 0) {
            s.z = 128;
            s.x = (Math.random() - 0.5) * 128;
            s.y = (Math.random() - 0.5) * 64;
          }
          const k = 128 / s.z;
          const px = cx + s.x * k;
          const py = cy + s.y * k;
          if (px >= 0 && px < w && py >= 0 && py < h) {
            const size = s.z < 40 ? 2 : 1;
            c.fillStyle = s.z < 50 ? primaryColor : dimColor;
            c.fillRect(Math.floor(px), Math.floor(py), size, size);
          }
        });
      } else if (anim === 1) {
        // Matrix Rain
        c.font = '6px monospace';
        stateRef.current.matrixDrops.forEach((dropY, col) => {
          const x = col * 8;
          const char = String.fromCharCode(33 + ((stateRef.current.time + col) % 90));
          c.fillStyle = primaryColor;
          c.fillText(char, x, dropY);
          c.fillStyle = dimColor;
          c.fillText(String.fromCharCode(33 + ((stateRef.current.time * 2 + col) % 90)), x, dropY - 8);

          stateRef.current.matrixDrops[col] = (dropY + 2) % (h + 16);
        });
      } else if (anim === 2) {
        // DVD Bounce
        const dvd = stateRef.current.dvd;
        dvd.x += dvd.vx;
        dvd.y += dvd.vy;

        if (dvd.x <= 0 || dvd.x + dvd.w >= w) dvd.vx *= -1;
        if (dvd.y <= 0 || dvd.y + dvd.h >= h) dvd.vy *= -1;

        c.strokeStyle = primaryColor;
        c.strokeRect(dvd.x, dvd.y, dvd.w, dvd.h);
        c.fillStyle = primaryColor;
        c.font = 'bold 7px monospace';
        c.fillText('DP-OLED', dvd.x + 2, dvd.y + 9);
      } else if (anim === 3) {
        // Sine Wave
        c.strokeStyle = primaryColor;
        c.beginPath();
        for (let x = 0; x < w; x++) {
          const y = h / 2 + Math.sin((x + stateRef.current.time * 2) * 0.08) * 18;
          if (x === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.stroke();
      } else {
        // Clock HUD
        const now = new Date();
        const str = now.toTimeString().split(' ')[0];
        c.fillStyle = primaryColor;
        c.font = 'bold 16px monospace';
        c.textAlign = 'center';
        c.fillText(str, 64, 36);
        c.font = '6px monospace';
        c.fillText('RP2040 REALTIME CLOCK', 64, 46);
        c.textAlign = 'left';
      }
    };

    const renderTestPattern = (c: CanvasRenderingContext2D, w: number, h: number) => {
      // Checkerboard test pattern
      c.fillStyle = primaryColor;
      for (let y = 0; y < h; y += 8) {
        for (let x = 0; x < w; x += 8) {
          if ((x / 8 + y / 8) % 2 === 0) {
            c.fillRect(x, y, 8, 8);
          }
        }
      }
      c.fillStyle = bgColor;
      c.fillRect(16, 24, 96, 16);
      c.fillStyle = primaryColor;
      c.font = 'bold 8px monospace';
      c.textAlign = 'center';
      c.fillText('128x64 OK · 400kHz', 64, 35);
      c.textAlign = 'left';
    };

    render();

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [
    viewMode,
    selectedAnim,
    isSleeping,
    theme,
    actuation,
    rtSens,
    rtEnabled,
    profileName,
    knobName,
    keys,
    lastActiveKey,
    apm,
    cps,
    totalKeystrokes,
    timerSeconds,
    timerRunning,
    customBitmap,
  ]);

  const handleSelectAnim = (anim: ScreensaverAnimation) => {
    setSelectedAnim(anim);
    onSendSerialCommand?.(`SCREENSAVER_ANIM ${anim}`);
  };

  const handleToggleSleep = () => {
    if (isSleeping) {
      onSendSerialCommand?.('WAKE');
    } else {
      onSendSerialCommand?.('SLEEP');
    }
  };

  const activeTheme = theme || DEFAULT_OLED_THEME;

  return (
    <div className="flex flex-col gap-3 bg-[#ffffff] p-3.5 sm:p-4 rounded-2xl border border-[#ded7ca] shadow-xs text-[#1b2930]">
      {/* Top Header */}
      <div className="flex items-center justify-between border-b border-[#f0ebdf] pb-2.5">
        <div className="flex items-center gap-2">
          <Monitor className="w-3.5 h-3.5 text-[#153641]" />
          <span className="text-xs font-bold text-[#1b2930]">OLED Live Display</span>
          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[#f6f3ec] text-[#71828a] border border-[#ded7ca]">
            0.96&quot; 128x64 White
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {viewMode === 'timer' && (
            <button
              onClick={() => setTimerRunning((prev) => !prev)}
              className="px-2 py-0.5 rounded-lg text-xs font-bold bg-[#153641] text-white hover:bg-[#0f262e] transition-colors"
            >
              {timerRunning ? 'Pause' : 'Start'}
            </button>
          )}

          {viewMode === 'custom' && onOpenPixelEditor && (
            <button
              onClick={onOpenPixelEditor}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#c86443] hover:bg-[#b25536] text-white transition-colors shadow-xs"
            >
              <Paintbrush className="w-3 h-3" />
              <span>Edit Graphic</span>
            </button>
          )}

          <button
            onClick={onOpenThemeModal}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#f7f4ee] hover:bg-[#ede7da] text-[#1b2930] border border-[#ded7ca] transition-colors shadow-xs"
            title="Display Color Simulation"
          >
            <span>Color Preset</span>
          </button>
        </div>
      </div>

      {/* Physical OLED Glass & Chamfered Bezel */}
      <div className="relative flex justify-center items-center bg-[#070b0e] p-3.5 rounded-2xl border-2 border-[#1a272e] shadow-inner overflow-hidden">
        <canvas
          ref={canvasRef}
          width={128}
          height={64}
          className="w-[256px] h-[128px] sm:w-[280px] sm:h-[140px] image-pixelated rounded ring-1 ring-white/10 shadow-lg"
          style={{
            imageRendering: 'pixelated',
            backgroundColor: activeTheme.background,
          }}
        />
        {isSleeping && (
          <div className="absolute inset-0 bg-[#070b0e]/90 flex items-center justify-center gap-1.5 text-xs text-[#71938c] font-mono">
            <Moon className="w-4 h-4 text-[#c86443]" /> DISPLAY SLEEPING
          </div>
        )}
      </div>

      {/* Modular OLED Widget Selector Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-xs">
        <div className="flex flex-wrap items-center gap-1 bg-[#f6f3ec] p-1 rounded-xl border border-[#ded7ca]">
          <button
            onClick={() => setViewMode('cockpit')}
            className={`px-2 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 transition-colors ${
              viewMode === 'cockpit'
                ? 'bg-[#ffffff] text-[#153641] shadow-xs border border-[#ded7ca]'
                : 'text-[#5a6a72] hover:text-[#1b2930]'
            }`}
          >
            <Briefcase className="w-3 h-3 text-[#c86443]" /> Cockpit
          </button>

          <button
            onClick={() => setViewMode('speedometer')}
            className={`px-2 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 transition-colors ${
              viewMode === 'speedometer'
                ? 'bg-[#ffffff] text-[#153641] shadow-xs border border-[#ded7ca]'
                : 'text-[#5a6a72] hover:text-[#1b2930]'
            }`}
          >
            <Gauge className="w-3 h-3 text-[#5b8e85]" /> APM Meter
          </button>

          <button
            onClick={() => setViewMode('heatmap')}
            className={`px-2 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 transition-colors ${
              viewMode === 'heatmap'
                ? 'bg-[#ffffff] text-[#153641] shadow-xs border border-[#ded7ca]'
                : 'text-[#5a6a72] hover:text-[#1b2930]'
            }`}
          >
            <LayoutGrid className="w-3 h-3 text-[#b45309]" /> 4x4 Map
          </button>

          <button
            onClick={() => setViewMode('timer')}
            className={`px-2 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 transition-colors ${
              viewMode === 'timer'
                ? 'bg-[#ffffff] text-[#153641] shadow-xs border border-[#ded7ca]'
                : 'text-[#5a6a72] hover:text-[#1b2930]'
            }`}
          >
            <Clock className="w-3 h-3 text-[#153641]" /> Focus Timer
          </button>

          <button
            onClick={() => setViewMode('custom')}
            className={`px-2 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 transition-colors ${
              viewMode === 'custom'
                ? 'bg-[#ffffff] text-[#153641] shadow-xs border border-[#ded7ca]'
                : 'text-[#5a6a72] hover:text-[#1b2930]'
            }`}
          >
            <Paintbrush className="w-3 h-3 text-[#c86443]" /> Custom Art
          </button>

          <button
            onClick={() => setViewMode('screensaver')}
            className={`px-2 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 transition-colors ${
              viewMode === 'screensaver'
                ? 'bg-[#ffffff] text-[#153641] shadow-xs border border-[#ded7ca]'
                : 'text-[#5a6a72] hover:text-[#1b2930]'
            }`}
          >
            <Sparkles className="w-3 h-3 text-[#5b8e85]" /> Screensaver
          </button>

          <button
            onClick={() => {
              setViewMode('test');
              onSendSerialCommand?.('OLED_TEST');
            }}
            className={`px-2 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
              viewMode === 'test'
                ? 'bg-[#ffffff] text-[#153641] shadow-xs border border-[#ded7ca]'
                : 'text-[#5a6a72] hover:text-[#1b2930]'
            }`}
          >
            Test
          </button>
        </div>

        {/* Animation Picker and Sleep Actions */}
        <div className="flex items-center gap-1.5">
          {viewMode === 'screensaver' && (
            <select
              value={selectedAnim}
              onChange={(e) => handleSelectAnim(Number(e.target.value) as ScreensaverAnimation)}
              className="bg-[#ffffff] text-[#1c282e] border border-[#d5ccc0] rounded-lg px-2 py-1 text-[11px] font-mono focus:outline-hidden focus:border-[#c86443]"
            >
              {[0, 1, 2, 3, 4, 5].map((a) => (
                <option key={a} value={a}>
                  {SCREENSAVER_NAMES[a as ScreensaverAnimation]}
                </option>
              ))}
            </select>
          )}

          <button
            onClick={handleToggleSleep}
            title={isSleeping ? 'Wake OLED' : 'Sleep OLED'}
            className="p-1.5 rounded-lg bg-[#ffffff] hover:bg-[#faf8f5] text-[#57676e] hover:text-[#1c282e] border border-[#e5dfd5] transition-colors"
          >
            {isSleeping ? <Eye className="w-3.5 h-3.5 text-[#c86443]" /> : <Moon className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={() => onSendSerialCommand?.('OLED_SCAN')}
            title="Scan I2C Bus (0x3C)"
            className="p-1.5 rounded-lg bg-[#ffffff] hover:bg-[#faf8f5] text-[#57676e] hover:text-[#1c282e] border border-[#e5dfd5] transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
