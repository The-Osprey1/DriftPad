import React, { useEffect, useRef, useState } from 'react';
import { KeyStatus, ScreensaverAnimation, SCREENSAVER_NAMES } from '../types/driftpad';
import { Eye, Moon, RefreshCw, Sparkles, Monitor } from 'lucide-react';

interface OledCanvasProps {
  activeLayer: number;
  actuation: number;
  rtSens: number;
  rtEnabled: boolean;
  keys: KeyStatus[];
  lastActiveKey: number;
  isSleeping?: boolean;
  screensaverActive?: boolean;
  forcedAnim?: number;
  onSendSerialCommand?: (cmd: string) => void;
}

export const OledCanvas: React.FC<OledCanvasProps> = ({
  activeLayer,
  actuation,
  rtSens,
  rtEnabled,
  keys,
  lastActiveKey,
  isSleeping = false,
  screensaverActive = false,
  forcedAnim = -1,
  onSendSerialCommand,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [selectedAnim, setSelectedAnim] = useState<ScreensaverAnimation>(0);
  const [viewMode, setViewMode] = useState<'cockpit' | 'screensaver' | 'test'>('cockpit');

  // Animation states for screensavers
  const animFrameRef = useRef<number | null>(null);
  const stateRef = useRef<{
    stars: { x: number; y: number; z: number }[];
    rain: { y: number; speed: number; len: number }[];
    oscPhase: number;
    gridOffset: number;
    ripples: { x: number; y: number; r: number; maxR: number }[];
    lifeGrid: boolean[][];
    badge: { x: number; y: number; dx: number; dy: number };
    time: number;
  }>({
    stars: Array.from({ length: 30 }, () => ({
      x: (Math.random() - 0.5) * 128,
      y: (Math.random() - 0.5) * 64,
      z: Math.random() * 80 + 10,
    })),
    rain: Array.from({ length: 16 }, () => ({
      y: Math.random() * 64,
      speed: Math.random() * 1.5 + 0.8,
      len: Math.floor(Math.random() * 8) + 4,
    })),
    oscPhase: 0,
    gridOffset: 0,
    ripples: [{ x: 64, y: 32, r: 2, maxR: 40 }],
    lifeGrid: Array.from({ length: 16 }, () =>
      Array.from({ length: 32 }, () => Math.random() > 0.7)
    ),
    badge: { x: 20, y: 20, dx: 0.8, dy: 0.6 },
    time: 0,
  });

  // Whenever a key is pressed, add a magnetic ripple
  useEffect(() => {
    if (lastActiveKey >= 0) {
      const col = lastActiveKey % 4;
      const row = Math.floor(lastActiveKey / 4);
      const cx = 20 + col * 28;
      const cy = 16 + row * 12;
      stateRef.current.ripples.push({ x: cx, y: cy, r: 2, maxR: 35 });
      if (stateRef.current.ripples.length > 6) {
        stateRef.current.ripples.shift();
      }
    }
  }, [lastActiveKey]);

  useEffect(() => {
    if (screensaverActive) {
      setViewMode('screensaver');
    }
    if (forcedAnim >= 0 && forcedAnim <= 5) {
      setSelectedAnim(forcedAnim as ScreensaverAnimation);
    }
  }, [screensaverActive, forcedAnim]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 128x64 display buffer
    const W = 128;
    const H = 64;

    const render = () => {
      stateRef.current.time += 1;
      ctx.fillStyle = '#05070a';
      ctx.fillRect(0, 0, W, H);

      if (isSleeping) {
        // Display completely off
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      if (viewMode === 'test') {
        // Checkerboard test pattern
        ctx.fillStyle = '#00f2fe';
        ctx.strokeStyle = '#00f2fe';
        ctx.strokeRect(0, 0, W, H);
        for (let y = 0; y < H; y += 8) {
          for (let x = 0; x < W; x += 8) {
            if ((Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0) {
              ctx.fillRect(x, y, 8, 8);
            }
          }
        }
        ctx.fillStyle = '#000000';
        ctx.fillRect(24, 24, 80, 16);
        ctx.strokeStyle = '#00f2fe';
        ctx.strokeRect(24, 24, 80, 16);
        ctx.fillStyle = '#00f2fe';
        ctx.font = '8px monospace';
        ctx.fillText('SSD1306 TEST', 28, 35);
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      if (viewMode === 'screensaver') {
        renderScreensaver(ctx, W, H, selectedAnim);
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      // Default: COCKPIT MODE
      renderCockpit(ctx, W, H);
      animFrameRef.current = requestAnimationFrame(render);
    };

    const renderCockpit = (c: CanvasRenderingContext2D, w: number, h: number) => {
      // Monochromatic OLED style with subtle cyan tint
      const primaryColor = '#00f2fe';
      const dimColor = '#0f4c5c';
      const bgColor = '#05080f';

      c.fillStyle = bgColor;
      c.fillRect(0, 0, w, h);

      // --- Top Status Bar (Y: 0 - 11) ---
      c.fillStyle = primaryColor;
      c.font = 'bold 7px monospace';
      const layerNames = ['L0:NUM', 'L1:NAV', 'L2:WASD'];
      c.fillText(layerNames[activeLayer] || `L${activeLayer}`, 2, 8);

      // RT Status pill
      if (rtEnabled) {
        c.fillRect(44, 1, 32, 9);
        c.fillStyle = '#000000';
        c.fillText('RT ON', 48, 8);
        c.fillStyle = primaryColor;
      } else {
        c.strokeStyle = dimColor;
        c.strokeRect(44, 1, 32, 9);
        c.fillText('RT OFF', 46, 8);
      }

      // Actuation / RT Sens readouts
      c.font = '6px monospace';
      c.fillText(`ACT:${actuation.toFixed(2)}`, 80, 8);

      // Horizontal separator line
      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 12);
      c.lineTo(w, 12);
      c.stroke();

      // --- Center Stage (Y: 13 - 52) ---
      const activeKeyObj = keys[lastActiveKey >= 0 ? lastActiveKey : 0] || {
        idx: 0,
        pressed: false,
        travel: 0.0,
        label: 'KEY',
      };

      // Left side: Active Key Box
      const isActuated = activeKeyObj.pressed;
      if (isActuated) {
        c.fillStyle = primaryColor;
        c.fillRect(3, 15, 34, 34);
        c.fillStyle = '#000000';
      } else {
        c.strokeStyle = primaryColor;
        c.strokeRect(3, 15, 34, 34);
        c.fillStyle = primaryColor;
      }

      c.font = 'bold 11px monospace';
      c.textAlign = 'center';
      c.fillText(activeKeyObj.label, 20, 32);

      c.font = '6px monospace';
      c.fillText(`#${activeKeyObj.idx}`, 20, 44);
      c.textAlign = 'left';

      // Right side: Analog Travel Gauge & RT limits
      c.fillStyle = primaryColor;
      c.font = 'bold 8px monospace';
      c.fillText(`${activeKeyObj.travel.toFixed(2)} mm`, 44, 23);

      c.font = '6px monospace';
      c.fillStyle = isActuated ? '#10b981' : '#9ca3af';
      c.fillText(isActuated ? 'ACTUATED' : 'REST/IDLE', 86, 23);

      // Travel Bar Track (Y: 28 to 38, width: 80)
      const trackX = 44;
      const trackY = 27;
      const trackW = 80;
      const trackH = 10;

      c.strokeStyle = dimColor;
      c.strokeRect(trackX, trackY, trackW, trackH);

      // Fill progress (0.0 to 4.0mm)
      const fillW = Math.max(0, Math.min(trackW, (activeKeyObj.travel / 4.0) * trackW));
      c.fillStyle = isActuated ? '#10b981' : primaryColor;
      c.fillRect(trackX + 1, trackY + 1, fillW, trackH - 2);

      // Actuation Point Marker line
      const actX = trackX + (actuation / 4.0) * trackW;
      c.strokeStyle = '#f59e0b';
      c.beginPath();
      c.moveTo(actX, trackY - 2);
      c.lineTo(actX, trackY + trackH + 2);
      c.stroke();

      // RT Sensitivity marker indicator
      c.fillStyle = '#9ca3af';
      c.font = '6px monospace';
      c.fillText(`0mm`, trackX, 47);
      c.fillText(`ACT`, actX - 6, 47);
      c.fillText(`4mm`, trackX + trackW - 14, 47);

      // --- Bottom Status Bar (Y: 53 - 63) ---
      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 52);
      c.lineTo(w, 52);
      c.stroke();

      c.fillStyle = primaryColor;
      c.font = '6px monospace';
      c.fillText(`DRIFTPAD HE // SENS ${rtSens.toFixed(2)}mm`, 3, 61);

      // Mini 4x4 matrix dots in bottom right
      for (let r = 0; r < 4; r++) {
        for (let col = 0; col < 4; col++) {
          const kIdx = r * 4 + col;
          const kPressed = keys[kIdx]?.pressed;
          const kActive = kIdx === activeKeyObj.idx;
          const dotX = 108 + col * 4;
          const dotY = 54 + r * 2;
          if (kPressed) {
            c.fillStyle = '#10b981';
            c.fillRect(dotX, dotY, 3, 2);
          } else if (kActive) {
            c.fillStyle = primaryColor;
            c.fillRect(dotX, dotY, 2, 1);
          } else {
            c.fillStyle = dimColor;
            c.fillRect(dotX, dotY, 1, 1);
          }
        }
      }
    };

    const renderScreensaver = (
      c: CanvasRenderingContext2D,
      w: number,
      h: number,
      anim: ScreensaverAnimation
    ) => {
      const st = stateRef.current;
      const cyan = '#00f2fe';

      if (anim === 0) {
        // 3D Warp Starfield & Floating Badge
        const cx = w / 2;
        const cy = h / 2;
        c.fillStyle = cyan;
        st.stars.forEach((s) => {
          s.z -= 1.8;
          if (s.z <= 1) {
            s.z = 80;
            s.x = (Math.random() - 0.5) * 128;
            s.y = (Math.random() - 0.5) * 64;
          }
          const px = cx + (s.x / s.z) * 60;
          const py = cy + (s.y / s.z) * 60;
          if (px >= 0 && px < w && py >= 0 && py < h) {
            const size = s.z < 25 ? 2 : 1;
            c.fillRect(px, py, size, size);
          }
        });

        // Bouncing DriftPad Badge
        st.badge.x += st.badge.dx;
        st.badge.y += st.badge.dy;
        if (st.badge.x <= 2 || st.badge.x >= w - 46) st.badge.dx = -st.badge.dx;
        if (st.badge.y <= 2 || st.badge.y >= h - 14) st.badge.dy = -st.badge.dy;

        c.fillStyle = '#090d16';
        c.fillRect(st.badge.x, st.badge.y, 44, 12);
        c.strokeStyle = cyan;
        c.strokeRect(st.badge.x, st.badge.y, 44, 12);
        c.fillStyle = cyan;
        c.font = 'bold 7px monospace';
        c.fillText('DRIFTPAD', st.badge.x + 4, st.badge.y + 9);
      } else if (anim === 1) {
        // Cyber Rain
        c.fillStyle = cyan;
        c.font = '6px monospace';
        st.rain.forEach((r, col) => {
          r.y += r.speed;
          if (r.y > h + 15) {
            r.y = -10;
            r.speed = Math.random() * 1.5 + 0.8;
          }
          const x = col * 8 + 2;
          for (let i = 0; i < r.len; i++) {
            const charY = r.y - i * 6;
            if (charY >= 0 && charY < h) {
              c.globalAlpha = Math.max(0.2, 1 - i / r.len);
              const char = String.fromCharCode(33 + ((col * 7 + i + st.time) % 60));
              c.fillText(char, x, charY);
            }
          }
        });
        c.globalAlpha = 1.0;
      } else if (anim === 2) {
        // Analog Oscilloscope
        st.oscPhase += 0.08;
        c.strokeStyle = cyan;
        c.lineWidth = 1;
        c.beginPath();
        for (let x = 0; x < w; x++) {
          const y =
            32 +
            Math.sin(x * 0.08 + st.oscPhase) * 14 +
            Math.sin(x * 0.16 - st.oscPhase * 1.5) * 6;
          if (x === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.stroke();

        c.fillStyle = cyan;
        c.font = '6px monospace';
        c.fillText('HALL FLUX OSC // 115.2kHz', 4, 10);
      } else if (anim === 3) {
        // Synthwave 3D Grid
        st.gridOffset = (st.gridOffset + 1) % 12;
        c.strokeStyle = cyan;
        const horizon = 22;

        // Perspective vertical lines
        const vpX = w / 2;
        const vpY = horizon;
        for (let x = -60; x <= w + 60; x += 18) {
          c.beginPath();
          c.moveTo(vpX, vpY);
          c.lineTo(x, h);
          c.stroke();
        }

        // Horizontal lines with perspective spacing
        for (let d = 0; d < 8; d++) {
          const y = horizon + Math.pow((d + st.gridOffset / 12) / 8, 2) * (h - horizon);
          if (y >= horizon && y <= h) {
            c.beginPath();
            c.moveTo(0, y);
            c.lineTo(w, y);
            c.stroke();
          }
        }

        // Sun / Radar at horizon
        c.beginPath();
        c.arc(w / 2, horizon, 10, Math.PI, 0);
        c.stroke();
      } else if (anim === 4) {
        // Magnetic Ripples
        c.strokeStyle = cyan;
        st.ripples.forEach((rip) => {
          rip.r += 0.8;
          if (rip.r < rip.maxR) {
            c.globalAlpha = 1 - rip.r / rip.maxR;
            c.beginPath();
            c.arc(rip.x, rip.y, rip.r, 0, Math.PI * 2);
            c.stroke();
          }
        });
        c.globalAlpha = 1.0;

        c.fillStyle = cyan;
        c.font = '6px monospace';
        c.fillText('MAGNETIC RIPPLES ACTIVE', 4, 10);
      } else if (anim === 5) {
        // Game of life
        if (st.time % 6 === 0) {
          const g = st.lifeGrid;
          const next = g.map((row) => [...row]);
          for (let r = 0; r < 16; r++) {
            for (let col = 0; col < 32; col++) {
              let neighbors = 0;
              for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                  if (dr === 0 && dc === 0) continue;
                  const nr = (r + dr + 16) % 16;
                  const nc = (col + dc + 32) % 32;
                  if (g[nr][nc]) neighbors++;
                }
              }
              if (g[r][col]) {
                next[r][col] = neighbors === 2 || neighbors === 3;
              } else {
                next[r][col] = neighbors === 3;
              }
            }
          }
          st.lifeGrid = next;
        }

        c.fillStyle = cyan;
        for (let r = 0; r < 16; r++) {
          for (let col = 0; col < 32; col++) {
            if (st.lifeGrid[r][col]) {
              c.fillRect(col * 4, r * 4, 3, 3);
            }
          }
        }
      }
    };

    render();

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [
    activeLayer,
    actuation,
    rtSens,
    rtEnabled,
    keys,
    lastActiveKey,
    isSleeping,
    viewMode,
    selectedAnim,
  ]);

  const handleSelectAnim = (a: ScreensaverAnimation) => {
    setSelectedAnim(a);
    setViewMode('screensaver');
    onSendSerialCommand?.(`ANIM ${a}`);
  };

  const handleToggleSleep = () => {
    if (isSleeping) {
      onSendSerialCommand?.('WAKE');
    } else {
      onSendSerialCommand?.('SLEEP');
    }
  };

  return (
    <div className="flex flex-col gap-3 bg-[#11141d] p-3.5 rounded-xl border border-[#2d3748]">
      <div className="flex items-center justify-between border-b border-[#2d3748] pb-2">
        <div className="flex items-center gap-2">
          <Monitor className="w-4 h-4 text-[#00f2fe]" />
          <span className="text-xs font-bold uppercase tracking-wider text-[#00f2fe]">
            SSD1306 128×64 OLED Cockpit
          </span>
        </div>
        <span className="text-[10px] text-[#9ca3af] font-mono">I2C: 0x3C @ 400kHz</span>
      </div>

      {/* Screen Frame with subtle glass reflections */}
      <div className="relative flex justify-center items-center bg-[#05070a] p-3 rounded-lg border-2 border-[#1c2230] shadow-inner overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-[#00f2fe]/5 to-transparent pointer-events-none" />
        <canvas
          ref={canvasRef}
          width={128}
          height={64}
          className="w-[256px] h-[128px] sm:w-[280px] sm:h-[140px] image-pixelated rounded shadow-[0_0_20px_rgba(0,242,254,0.15)] bg-black"
          style={{ imageRendering: 'pixelated' }}
        />
        {isSleeping && (
          <div className="absolute inset-0 bg-black/80 flex items-center justify-center gap-1.5 text-xs text-[#9ca3af] font-mono">
            <Moon className="w-4 h-4" /> DISPLAY SLEEPING
          </div>
        )}
      </div>

      {/* Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
        <div className="flex items-center gap-1 bg-[#181c27] p-1 rounded-md border border-[#2d3748]">
          <button
            onClick={() => setViewMode('cockpit')}
            className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-all ${
              viewMode === 'cockpit'
                ? 'bg-[#00f2fe] text-black shadow-sm'
                : 'text-[#9ca3af] hover:text-white'
            }`}
          >
            Cockpit HUD
          </button>
          <button
            onClick={() => setViewMode('screensaver')}
            className={`px-2.5 py-1 rounded text-[11px] font-semibold flex items-center gap-1 transition-all ${
              viewMode === 'screensaver'
                ? 'bg-[#00f2fe] text-black shadow-sm'
                : 'text-[#9ca3af] hover:text-white'
            }`}
          >
            <Sparkles className="w-3 h-3" /> Screensaver
          </button>
          <button
            onClick={() => {
              setViewMode('test');
              onSendSerialCommand?.('OLED_TEST');
            }}
            className={`px-2 py-1 rounded text-[11px] font-semibold transition-all ${
              viewMode === 'test'
                ? 'bg-[#00f2fe] text-black shadow-sm'
                : 'text-[#9ca3af] hover:text-white'
            }`}
          >
            Test Grid
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          {viewMode === 'screensaver' && (
            <select
              value={selectedAnim}
              onChange={(e) => handleSelectAnim(Number(e.target.value) as ScreensaverAnimation)}
              className="bg-[#181c27] text-white border border-[#2d3748] rounded px-2 py-1 text-[11px] font-mono focus:outline-none focus:border-[#00f2fe]"
            >
              {[0, 1, 2, 3, 4, 5].map((a) => (
                <option key={a} value={a}>
                  Anim {a}: {SCREENSAVER_NAMES[a as ScreensaverAnimation]}
                </option>
              ))}
            </select>
          )}

          <button
            onClick={handleToggleSleep}
            title={isSleeping ? 'Wake OLED' : 'Sleep OLED'}
            className="p-1.5 rounded bg-[#181c27] hover:bg-[#222738] text-[#9ca3af] hover:text-[#00f2fe] border border-[#2d3748]"
          >
            {isSleeping ? <Eye className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={() => onSendSerialCommand?.('OLED_SCAN')}
            title="Scan I2C Bus"
            className="p-1.5 rounded bg-[#181c27] hover:bg-[#222738] text-[#9ca3af] hover:text-[#00f2fe] border border-[#2d3748]"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
