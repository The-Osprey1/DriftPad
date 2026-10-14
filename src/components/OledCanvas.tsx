import React, { useEffect, useRef, useState } from 'react';
import {
  KeyStatus,
  ScreensaverAnimation,
  SCREENSAVER_NAMES,
  OledThemeConfig,
  DEFAULT_OLED_THEME,
} from '../types/driftpad';
import {
  Eye,
  Moon,
  RefreshCw,
  Sparkles,
  Monitor,
  Briefcase,
  Palette,
} from 'lucide-react';

interface OledCanvasProps {
  activeLayer?: number;
  actuation: number;
  rtSens: number;
  rtEnabled: boolean;
  keys: KeyStatus[];
  lastActiveKey: number;
  profileName?: string;
  knobName?: string;
  theme?: OledThemeConfig;
  isSleeping?: boolean;
  screensaverActive?: boolean;
  forcedAnim?: number;
  onSendSerialCommand?: (cmd: string) => void;
  onOpenThemeModal?: () => void;
}

export const OledCanvasComponent: React.FC<OledCanvasProps> = ({
  actuation,
  rtSens,
  rtEnabled,
  keys,
  lastActiveKey,
  profileName = 'Standard Number Pad',
  knobName = 'Volume Dial',
  theme,
  isSleeping = false,
  screensaverActive = false,
  forcedAnim = -1,
  onSendSerialCommand,
  onOpenThemeModal,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [selectedAnim, setSelectedAnim] = useState<ScreensaverAnimation>(0);
  const [viewMode, setViewMode] = useState<'productivity' | 'cockpit' | 'screensaver' | 'test'>(
    'productivity'
  );

  // Maintain a ref to current props to avoid re-subscribing requestAnimationFrame loop on every prop change
  const propsRef = useRef({
    actuation,
    rtSens,
    rtEnabled,
    keys,
    lastActiveKey,
    profileName,
    knobName,
    theme,
    isSleeping,
    screensaverActive,
    forcedAnim,
  });

  propsRef.current = {
    actuation,
    rtSens,
    rtEnabled,
    keys,
    lastActiveKey,
    profileName,
    knobName,
    theme,
    isSleeping,
    screensaverActive,
    forcedAnim,
  };

  const animFrameRef = useRef<number | null>(null);
  const stateRef = useRef<{
    stars: { x: number; y: number; z: number }[];
    rain: { y: number; speed: number; len: number }[];
    oscPhase: number;
    gridOffset: number;
    ripples: { x: number; y: number; r: number; maxR: number }[];
    lifeGrid: Uint8Array;
    nextLifeGrid: Uint8Array;
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
    lifeGrid: (() => {
      const grid = new Uint8Array(512);
      for (let i = 0; i < 512; i++) {
        if (Math.random() > 0.7) grid[i] = 1;
      }
      return grid;
    })(),
    nextLifeGrid: new Uint8Array(512),
    badge: { x: 20, y: 20, dx: 0.8, dy: 0.6 },
    time: 0,
  });

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

    const W = 128;
    const H = 64;

    const render = () => {
      const {
        actuation: curActuation,
        rtSens: curRtSens,
        rtEnabled: curRtEnabled,
        keys: curKeys,
        lastActiveKey: curLastActiveKey,
        profileName: curProfileName,
        knobName: curKnobName,
        theme: curTheme,
        isSleeping: curIsSleeping,
      } = propsRef.current;

      // Single-Color Monochrome White OLED (SSD1306 hardware match)
      const activeTheme = curTheme || DEFAULT_OLED_THEME;
      const primaryColor = activeTheme.textColor || '#e8f1ee';
      const bgColor = activeTheme.background || '#12242b';
      const graphColor = activeTheme.graphColor || '#71938c';
      const dimColor = activeTheme.dimColor || '#28464f';
      const accentColor = activeTheme.accentColor || '#e07a5f';

      stateRef.current.time += 1;
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, W, H);

      if (curIsSleeping) {
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      if (viewMode === 'test') {
        // Checkerboard test pattern
        ctx.fillStyle = primaryColor;
        ctx.strokeStyle = primaryColor;
        for (let y = 0; y < H; y += 8) {
          for (let x = 0; x < W; x += 8) {
            if ((x / 8 + y / 8) % 2 === 0) {
              ctx.fillRect(x, y, 8, 8);
            }
          }
        }
        ctx.fillStyle = bgColor;
        ctx.fillRect(20, 24, 88, 16);
        ctx.fillStyle = primaryColor;
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('128x64 OK · 400kHz', 64, 35);
        ctx.textAlign = 'left';
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      if (viewMode === 'screensaver') {
        renderScreensaver(ctx, W, H, selectedAnim, primaryColor, bgColor, graphColor, dimColor, accentColor);
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      if (viewMode === 'productivity') {
        renderProductivity(
          ctx, W, H, curActuation, curRtSens, curRtEnabled, curKeys, curLastActiveKey, curProfileName, curKnobName,
          primaryColor, bgColor, graphColor, dimColor, accentColor
        );
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      // Default: Cockpit
      renderCockpit(
        ctx, W, H, curActuation, curRtSens, curRtEnabled, curKeys, curLastActiveKey, curProfileName,
        primaryColor, bgColor, graphColor, dimColor, accentColor
      );
      animFrameRef.current = requestAnimationFrame(render);
    };

    const renderProductivity = (
      c: CanvasRenderingContext2D,
      w: number,
      h: number,
      curActuation: number,
      curRtSens: number,
      curRtEnabled: boolean,
      curKeys: KeyStatus[],
      curLastActiveKey: number,
      curProfileName: string,
      curKnobName: string,
      primaryColor: string,
      bgColor: string,
      graphColor: string,
      dimColor: string,
      accentColor: string
    ) => {
      c.fillStyle = bgColor;
      c.fillRect(0, 0, w, h);

      // --- Top Status: Workspace Name & 16-Key Badge ---
      c.fillStyle = primaryColor;
      c.font = 'bold 7px monospace';
      const cleanProfile = curProfileName.slice(0, 14).toUpperCase();
      c.fillText(cleanProfile, 2, 8);

      // Workspace 16-key pad badge
      c.fillStyle = primaryColor;
      c.fillRect(90, 1, 36, 9);
      c.fillStyle = bgColor;
      c.fillText('16-KEY', 94, 8);
      c.fillStyle = primaryColor;

      // Divider
      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 12);
      c.lineTo(w, 12);
      c.stroke();

      // --- Center: Active Key Box + Knob Readout ---
      const activeKeyObj = curKeys[curLastActiveKey >= 0 ? curLastActiveKey : 0] || {
        idx: 0,
        pressed: false,
        travel: 0.0,
        label: 'KEY',
      };

      const isActuated = activeKeyObj.pressed;
      if (isActuated) {
        c.fillStyle = accentColor;
        c.fillRect(3, 15, 34, 34);
        c.fillStyle = '#ffffff';
      } else {
        c.strokeStyle = graphColor;
        c.strokeRect(3, 15, 34, 34);
        c.fillStyle = primaryColor;
      }

      c.font = 'bold 11px monospace';
      c.textAlign = 'center';
      c.fillText(activeKeyObj.label, 20, 32);

      c.font = '6px monospace';
      c.fillText(`#${activeKeyObj.idx}`, 20, 44);
      c.textAlign = 'left';

      // Dial Readout on right
      c.fillStyle = primaryColor;
      c.font = '6px monospace';
      c.fillText(`DIAL: ${curKnobName.slice(0, 13).toUpperCase()}`, 42, 22);

      // Travel reading
      c.font = 'bold 7px monospace';
      c.fillStyle = isActuated ? accentColor : primaryColor;
      c.fillText(`${activeKeyObj.travel.toFixed(2)}mm`, 42, 33);

      c.font = '6px monospace';
      c.fillStyle = isActuated ? accentColor : dimColor;
      c.fillText(isActuated ? 'ACTUATED' : 'REST/IDLE', 86, 33);

      // Travel Track
      const trackX = 42;
      const trackY = 37;
      const trackW = 82;
      const trackH = 8;
      c.strokeStyle = dimColor;
      c.strokeRect(trackX, trackY, trackW, trackH);

      const fillW = Math.max(0, Math.min(trackW, (activeKeyObj.travel / 4.0) * trackW));
      c.fillStyle = isActuated ? accentColor : graphColor;
      c.fillRect(trackX + 1, trackY + 1, fillW, trackH - 2);

      // Actuation Line
      const effAct = activeKeyObj.customActuation ?? curActuation;
      const actX = trackX + (effAct / 4.0) * trackW;
      c.strokeStyle = accentColor;
      c.beginPath();
      c.moveTo(actX, trackY - 1);
      c.lineTo(actX, trackY + trackH + 1);
      c.stroke();

      // --- Bottom Status ---
      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 52);
      c.lineTo(w, 52);
      c.stroke();

      c.fillStyle = primaryColor;
      c.font = '6px monospace';
      c.fillText(`ACT:${effAct.toFixed(2)}mm · RT:${curRtEnabled ? `${curRtSens.toFixed(2)}mm` : 'OFF'}`, 2, 61);
    };

    const renderCockpit = (
      c: CanvasRenderingContext2D,
      w: number,
      h: number,
      curActuation: number,
      curRtSens: number,
      curRtEnabled: boolean,
      curKeys: KeyStatus[],
      curLastActiveKey: number,
      curProfileName: string,
      primaryColor: string,
      bgColor: string,
      graphColor: string,
      dimColor: string,
      accentColor: string
    ) => {
      c.fillStyle = bgColor;
      c.fillRect(0, 0, w, h);

      c.fillStyle = primaryColor;
      c.font = 'bold 7px monospace';
      const cleanProfile = curProfileName.slice(0, 9).toUpperCase();
      c.fillText(cleanProfile, 2, 8);

      if (curRtEnabled) {
        c.fillStyle = accentColor;
        c.fillRect(48, 1, 32, 9);
        c.fillStyle = '#ffffff';
        c.fillText('RT ON', 52, 8);
        c.fillStyle = primaryColor;
      } else {
        c.strokeStyle = dimColor;
        c.strokeRect(48, 1, 32, 9);
        c.fillText('RT OFF', 50, 8);
      }

      c.font = '6px monospace';
      c.fillText(`ACT:${curActuation.toFixed(2)}`, 84, 8);

      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 12);
      c.lineTo(w, 12);
      c.stroke();

      const activeKeyObj = curKeys[curLastActiveKey >= 0 ? curLastActiveKey : 0] || {
        idx: 0,
        pressed: false,
        travel: 0.0,
        label: 'KEY',
      };

      const isActuated = activeKeyObj.pressed;
      if (isActuated) {
        c.fillStyle = accentColor;
        c.fillRect(3, 15, 34, 34);
        c.fillStyle = '#ffffff';
      } else {
        c.strokeStyle = graphColor;
        c.strokeRect(3, 15, 34, 34);
        c.fillStyle = primaryColor;
      }

      c.font = 'bold 11px monospace';
      c.textAlign = 'center';
      c.fillText(activeKeyObj.label, 20, 32);

      c.font = '6px monospace';
      c.fillText(`#${activeKeyObj.idx}`, 20, 44);
      c.textAlign = 'left';

      c.fillStyle = primaryColor;
      c.font = 'bold 8px monospace';
      c.fillText(`${activeKeyObj.travel.toFixed(2)} mm`, 44, 23);

      c.font = '6px monospace';
      c.fillStyle = isActuated ? accentColor : dimColor;
      c.fillText(isActuated ? 'ACTUATED' : 'REST/IDLE', 86, 23);

      const trackX = 44;
      const trackY = 27;
      const trackW = 80;
      const trackH = 10;

      c.strokeStyle = dimColor;
      c.strokeRect(trackX, trackY, trackW, trackH);

      const fillW = Math.max(0, Math.min(trackW, (activeKeyObj.travel / 4.0) * trackW));
      c.fillStyle = isActuated ? accentColor : graphColor;
      c.fillRect(trackX + 1, trackY + 1, fillW, trackH - 2);

      const effAct = activeKeyObj.customActuation ?? curActuation;
      const actX = trackX + (effAct / 4.0) * trackW;
      c.strokeStyle = accentColor;
      c.beginPath();
      c.moveTo(actX, trackY - 2);
      c.lineTo(actX, trackY + trackH + 2);
      c.stroke();

      c.strokeStyle = dimColor;
      c.beginPath();
      c.moveTo(0, 52);
      c.lineTo(w, 52);
      c.stroke();

      c.fillStyle = primaryColor;
      c.font = '6px monospace';
      c.fillText(`DRIFTPAD · RT ${curRtSens.toFixed(2)}mm`, 3, 61);

      for (let r = 0; r < 4; r++) {
        for (let col = 0; col < 4; col++) {
          const kIdx = r * 4 + col;
          const kPressed = curKeys[kIdx]?.pressed;
          const kActive = kIdx === activeKeyObj.idx;
          const dotX = 108 + col * 4;
          const dotY = 54 + r * 2;
          if (kPressed) {
            c.fillStyle = accentColor;
            c.fillRect(dotX, dotY, 3, 2);
          } else if (kActive) {
            c.fillStyle = graphColor;
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
      anim: ScreensaverAnimation,
      primaryColor: string,
      bgColor: string,
      graphColor: string,
      dimColor: string,
      accentColor: string
    ) => {
      const st = stateRef.current;
      const glow = graphColor;

      if (anim === 0) {
        const cx = w / 2;
        const cy = h / 2;
        c.fillStyle = glow;
        // Optimized indexed for-loop (avoids per-frame callback function allocations)
        const stars = st.stars;
        for (let i = 0; i < stars.length; i++) {
          const s = stars[i];
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
        }

        st.badge.x += st.badge.dx;
        st.badge.y += st.badge.dy;
        if (st.badge.x <= 2 || st.badge.x >= w - 46) st.badge.dx = -st.badge.dx;
        if (st.badge.y <= 10 || st.badge.y >= h - 14) st.badge.dy = -st.badge.dy;

        c.fillStyle = bgColor;
        c.fillRect(st.badge.x - 2, st.badge.y - 2, 46, 14);
        c.strokeStyle = accentColor;
        c.strokeRect(st.badge.x - 2, st.badge.y - 2, 46, 14);
        c.fillStyle = primaryColor;
        c.font = 'bold 7px monospace';
        c.fillText('DRIFTPAD', st.badge.x + 2, st.badge.y + 8);
        return;
      }

      if (anim === 1) {
        c.fillStyle = glow;
        c.font = '7px monospace';
        // Optimized indexed for-loop
        const rain = st.rain;
        for (let i = 0; i < rain.length; i++) {
          const r = rain[i];
          r.y += r.speed;
          if (r.y > h + 10) r.y = -5;
          const char = String.fromCharCode(0x30 + ((st.time + i) % 10));
          c.fillText(char, i * 8 + 2, r.y);
          c.fillStyle = dimColor;
          c.fillRect(i * 8 + 4, r.y - r.len, 1, r.len);
          c.fillStyle = glow;
        }
        return;
      }

      if (anim === 2) {
        st.oscPhase += 0.08;
        c.strokeStyle = glow;
        c.lineWidth = 1;
        c.beginPath();
        for (let x = 0; x < w; x++) {
          const y =
            h / 2 +
            Math.sin(x * 0.09 + st.oscPhase) * 16 +
            Math.sin(x * 0.03 - st.oscPhase * 1.4) * 8;
          if (x === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.stroke();
        return;
      }

      if (anim === 3) {
        st.gridOffset = (st.gridOffset + 1.2) % 16;
        const horizon = 24;
        c.strokeStyle = dimColor;
        c.lineWidth = 1;

        c.beginPath();
        c.moveTo(0, horizon);
        c.lineTo(w, horizon);
        c.stroke();

        const vanishX = w / 2;
        for (let x = -w; x <= w * 2; x += 18) {
          c.beginPath();
          c.moveTo(vanishX, horizon);
          c.lineTo(x, h);
          c.stroke();
        }

        for (let y = horizon; y < h; y += 7) {
          const currentY = y + (st.gridOffset % 7);
          if (currentY < h) {
            c.beginPath();
            c.moveTo(0, currentY);
            c.lineTo(w, currentY);
            c.stroke();
          }
        }
        return;
      }

      if (anim === 4) {
        c.strokeStyle = glow;
        c.lineWidth = 1;
        // Optimized indexed for-loop
        const ripples = st.ripples;
        for (let i = 0; i < ripples.length; i++) {
          const r = ripples[i];
          r.r += 1.2;
          if (r.r < r.maxR) {
            c.beginPath();
            c.arc(r.x, r.y, r.r, 0, Math.PI * 2);
            c.stroke();
          }
        }
        return;
      }

      if (anim === 5) {
        if (st.time % 10 === 0) {
          const curr = st.lifeGrid;
          const next = st.nextLifeGrid;
          for (let r = 0; r < 16; r++) {
            const rowOffset = r << 5;
            const rAbove = ((r - 1 + 16) & 15) << 5;
            const rBelow = ((r + 1) & 15) << 5;

            for (let col = 0; col < 32; col++) {
              const cLeft = (col - 1 + 32) & 31;
              const cRight = (col + 1) & 31;

              const neighbors =
                curr[rAbove + cLeft] +
                curr[rAbove + col] +
                curr[rAbove + cRight] +
                curr[rowOffset + cLeft] +
                curr[rowOffset + cRight] +
                curr[rBelow + cLeft] +
                curr[rBelow + col] +
                curr[rBelow + cRight];

              const idx = rowOffset + col;
              const cell = curr[idx];
              next[idx] =
                (cell === 1 && (neighbors === 2 || neighbors === 3)) || (cell === 0 && neighbors === 3) ? 1 : 0;
            }
          }
          // Swap buffers without allocations
          st.lifeGrid = next;
          st.nextLifeGrid = curr;
        }

        c.fillStyle = glow;
        const grid = st.lifeGrid;
        for (let r = 0; r < 16; r++) {
          const rowOffset = r << 5;
          const py = r * 4;
          for (let col = 0; col < 32; col++) {
            if (grid[rowOffset + col] === 1) {
              c.fillRect(col * 4, py, 3, 3);
            }
          }
        }
      }
    };

    render();

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [viewMode, selectedAnim]);

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
    <div className="flex flex-col gap-3 bg-[#ffffff] p-3.5 sm:p-4 rounded-2xl border border-[#ded7ca] shadow-sm text-[#1b2930]">
      {/* Top Header */}
      <div className="flex items-center justify-between border-b border-[#f0ebdF] pb-2.5">
        <div className="flex items-center gap-2">
          <Monitor className="w-3.5 h-3.5 text-[#153641]" />
          <span className="text-xs font-bold text-[#1b2930]">
            OLED Live Display
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[#f6f3ec] text-[#71828a] border border-[#ded7ca]">
            128x64 White
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onOpenThemeModal}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#f7f4ee] hover:bg-[#ede7da] text-[#1b2930] border border-[#ded7ca] transition-colors shadow-xs"
            title="OLED Display Settings"
          >
            <Palette className="w-3.5 h-3.5 text-[#c86443]" />
            <span>Theme</span>
          </button>
        </div>
      </div>

      {/* Physical OLED Glass & Bezel */}
      <div className="relative flex justify-center items-center bg-[#0d1a20] p-3 rounded-2xl border border-[#243c44] shadow-inner overflow-hidden">
        <canvas
          ref={canvasRef}
          width={128}
          height={64}
          className="w-[256px] h-[128px] sm:w-[280px] sm:h-[140px] image-pixelated rounded"
          style={{
            imageRendering: 'pixelated',
            backgroundColor: activeTheme.background,
          }}
        />
        {isSleeping && (
          <div className="absolute inset-0 bg-[#0d1a20]/90 flex items-center justify-center gap-1.5 text-xs text-[#71938c] font-mono">
            <Moon className="w-4 h-4 text-[#e07a5f]" /> DISPLAY SLEEPING
          </div>
        )}
      </div>

      {/* View Mode Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-xs">
        <div className="flex items-center gap-1 bg-[#f6f3ec] p-1 rounded-xl border border-[#ded7ca]">
          <button
            onClick={() => setViewMode('productivity')}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 transition-colors ${
              viewMode === 'productivity'
                ? 'bg-[#ffffff] text-[#153641] shadow-xs border border-[#ded7ca]'
                : 'text-[#5a6a72] hover:text-[#1b2930]'
            }`}
          >
            <Briefcase className="w-3 h-3 text-[#c86443]" /> Workspace
          </button>
          <button
            onClick={() => setViewMode('cockpit')}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
              viewMode === 'cockpit'
                ? 'bg-[#ffffff] text-[#153641] shadow-xs border border-[#ded7ca]'
                : 'text-[#5a6a72] hover:text-[#1b2930]'
            }`}
          >
            Cockpit HUD
          </button>
          <button
            onClick={() => setViewMode('screensaver')}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 transition-colors ${
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

        <div className="flex items-center gap-1.5">
          {viewMode === 'screensaver' && (
            <select
              value={selectedAnim}
              onChange={(e) => handleSelectAnim(Number(e.target.value) as ScreensaverAnimation)}
              className="bg-[#ffffff] text-[#1c282e] border border-[#d5ccc0] rounded-lg px-2 py-1 text-[11px] font-mono focus:outline-none focus:border-[#9e5b3d]"
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
            {isSleeping ? <Eye className="w-3.5 h-3.5 text-[#9e5b3d]" /> : <Moon className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={() => onSendSerialCommand?.('OLED_SCAN')}
            title="Scan I2C Bus"
            className="p-1.5 rounded-lg bg-[#ffffff] hover:bg-[#faf8f5] text-[#57676e] hover:text-[#1c282e] border border-[#e5dfd5] transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};

export const OledCanvas = React.memo(OledCanvasComponent);
