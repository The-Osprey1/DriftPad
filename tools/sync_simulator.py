import os

path = r"C:\Users\devyn\.gemini\antigravity\brain\5718f2fc-a709-431c-bfa8-22edc30be32b\home_screen_designer.html"
with open(path, "r", encoding="utf-8") as f:
    c = f.read()

# Normalize CRLF
c = c.replace("\r\n", "\n")

old_header = """      // Inverted Drift Speed Banner (X: 7..77, Y: 0..10) - 71px wide
      fillRect(7, 0, 71, 10, true);
      drawText("DRIFTPAD V2", 9, 1, 1, false);

      // Slanted kinetic speed chevrons
      ctx.strokeStyle = '#e0f7fa';
      ctx.lineWidth = SCALE;
      ctx.beginPath();
      ctx.moveTo(80 * SCALE, 0);
      ctx.lineTo(75 * SCALE, 10 * SCALE);
      ctx.moveTo(84 * SCALE, 0);
      ctx.lineTo(79 * SCALE, 10 * SCALE);
      ctx.moveTo(88 * SCALE, 0);
      ctx.lineTo(83 * SCALE, 10 * SCALE);
      ctx.stroke();

      // Right Status Pill (X: 91..126, Y: 0..10) - 36px wide
      drawRect(91, 0, 36, 11, true);
      drawText("L0|RT", 94, 2, 1, true);"""

new_header = """      // Inverted Drift Speed Banner (X: 7..72, Y: 0..10) - 66px wide
      fillRect(7, 0, 66, 10, true);
      drawText("DRIFTPAD V2", 8, 1, 1, false);

      // Slanted kinetic speed chevrons /// (X: 77..85)
      ctx.strokeStyle = '#e0f7fa';
      ctx.lineWidth = SCALE;
      ctx.beginPath();
      ctx.moveTo(77 * SCALE, 0);
      ctx.lineTo(74 * SCALE, 10 * SCALE);
      ctx.moveTo(81 * SCALE, 0);
      ctx.lineTo(78 * SCALE, 10 * SCALE);
      ctx.moveTo(85 * SCALE, 0);
      ctx.lineTo(82 * SCALE, 10 * SCALE);
      ctx.stroke();

      // Right Status Pill (X: 87..126, Y: 0..10) - 40px wide
      drawRect(87, 0, 40, 11, true);
      drawText("L0:RT", 93, 2, 1, true);"""

assert old_header in c, "old_header not found"
c = c.replace(old_header, new_header)

old_cockpit = """      // Chamfered Cyber Cockpit Card (X: 5, Y: 22, W: 54, H: 27)
      const cx = 5, cy = 22, cw = 54, ch = 27;

      // Top/bottom racing dashes
      drawFastHLine(10, 20, 44, true);
      drawFastHLine(10, 50, 44, true);"""

new_cockpit = """      // Chamfered Cyber Cockpit Card (X: 5, Y: 23, W: 54, H: 26)
      const cx = 5, cy = 23, cw = 54, ch = 26;

      // Top/bottom framing accents with clear spacing
      drawFastHLine(14, 21, 36, true);
      drawFastHLine(14, 50, 36, true);"""

assert old_cockpit in c, "old_cockpit not found"
c = c.replace(old_cockpit, new_cockpit)

# Slashes in card
old_slashes = """          ctx.moveTo(13 * SCALE, 26 * SCALE);
          ctx.lineTo(10 * SCALE, 44 * SCALE);
          ctx.moveTo(50 * SCALE, 26 * SCALE);
          ctx.lineTo(47 * SCALE, 44 * SCALE);"""

new_slashes = """          ctx.moveTo(12 * SCALE, 27 * SCALE);
          ctx.lineTo(9 * SCALE, 44 * SCALE);
          ctx.moveTo(15 * SCALE, 27 * SCALE);
          ctx.lineTo(12 * SCALE, 44 * SCALE);
          ctx.moveTo(49 * SCALE, 27 * SCALE);
          ctx.lineTo(46 * SCALE, 44 * SCALE);
          ctx.moveTo(52 * SCALE, 27 * SCALE);
          ctx.lineTo(49 * SCALE, 44 * SCALE);"""

assert old_slashes in c, "old_slashes not found"
c = c.replace(old_slashes, new_slashes)

# Motec tachometer
old_motec = """      // Bottom of left panel: travel depth + 6-Stage Motec Tachometer (X: 41..63, Y: 51..59)
      drawText(`${travelMm.toFixed(2)}mm`, 3, 52, 1, true); // spans X: 3..37

      let activeSegs = Math.round((travelMm / 4.0) * 6);
      if (isPressed && activeSegs < 4) activeSegs = 4;
      if (activeSegs > 6) activeSegs = 6;

      ctx.strokeStyle = '#e0f7fa';
      ctx.lineWidth = SCALE;
      for (let s = 0; s < 5; s++) {
        const sx = 41 + s * 4;
        if (s < activeSegs) {
          ctx.beginPath();
          ctx.moveTo(sx * SCALE, 58 * SCALE);
          ctx.lineTo((sx + 2) * SCALE, 52 * SCALE);
          ctx.moveTo((sx + 1) * SCALE, 58 * SCALE);
          ctx.lineTo((sx + 3) * SCALE, 52 * SCALE);
          ctx.stroke();
        } else {
          drawPixel(sx + 1, 58, true); // Track dot
        }
      }
      // Segment 5: Redline Shift Block
      if (activeSegs >= 6 || isPressed) {
        if (isPressed && (animPhase % 2 === 0)) {
          fillRect(61, 51, 3, 8, true); // Strobe F1 Shift Light
        } else {
          drawRect(61, 51, 3, 8, true);
        }
      } else {
        drawPixel(62, 58, true);
      }"""

new_motec = """      // Bottom of left panel: travel depth + 6-Stage Motec Tachometer (X: 41..63, Y: 52..59)
      drawText(`${travelMm.toFixed(2)}mm`, 3, 53, 1, true); // spans X: 3..37

      let activeSegs = Math.round((travelMm / 4.0) * 6);
      if (isPressed && activeSegs < 3) activeSegs = 3;
      if (activeSegs > 6) activeSegs = 6;

      ctx.strokeStyle = '#e0f7fa';
      ctx.lineWidth = SCALE;
      for (let s = 0; s < 5; s++) {
        const sx = 41 + s * 4;
        if (s < activeSegs) {
          ctx.beginPath();
          ctx.moveTo(sx * SCALE, 59 * SCALE);
          ctx.lineTo((sx + 2) * SCALE, 53 * SCALE);
          ctx.moveTo((sx + 1) * SCALE, 59 * SCALE);
          ctx.lineTo((sx + 3) * SCALE, 53 * SCALE);
          ctx.stroke();
        } else {
          drawPixel(sx + 1, 59, true); // Track dot
        }
      }
      // Segment 5: Redline Shift Block
      if (activeSegs >= 6 || isPressed) {
        if (isPressed && (animPhase % 2 === 0)) {
          fillRect(61, 52, 3, 8, true); // Strobe F1 Shift Light
        } else {
          drawRect(61, 52, 3, 8, true);
        }
      } else {
        drawPixel(62, 59, true);
      }"""

assert old_motec in c, "old_motec not found"
c = c.replace(old_motec, new_motec)

# Matrix animation
old_anim = """          if (isCurrentActive && isPressed) {
            // Full-Matrix Tactical Laser Scanline & Expanding Diamond
            drawFastHLine(68, by + 4, 54, true);
            drawFastVLine(bx + 5, 14, 47, true);

            const d = (1 + (animPhase % 3)) * 2;
            if (bx + 5 - d >= 67 && bx + 5 + d <= 123 && by + 4 - d >= 13 && by + 4 + d <= 61) {
              ctx.strokeStyle = '#e0f7fa';
              ctx.lineWidth = SCALE;
              ctx.beginPath();
              ctx.moveTo((bx + 5 - d) * SCALE, (by + 4) * SCALE);
              ctx.lineTo((bx + 5) * SCALE, (by + 4 - d) * SCALE);
              ctx.lineTo((bx + 5 + d) * SCALE, (by + 4) * SCALE);
              ctx.lineTo((bx + 5) * SCALE, (by + 4 + d) * SCALE);
              ctx.closePath();
              ctx.stroke();
            }

            // Mechanical Sinking Keycap: Sinks DOWN 2 pixels (by+2 to by+8)
            fillRect(bx, by + 2, BOX_W, 7, true);
            drawPixel(bx, by + 2, false);
            drawPixel(bx + BOX_W - 1, by + 2, false);
            drawPixel(bx, by + 8, false);
            drawPixel(bx + BOX_W - 1, by + 8, false);

            // Inverted center crosshair diamond
            drawPixel(bx + 5, by + 5, false);
            drawPixel(bx + 4, by + 5, false);
            drawPixel(bx + 6, by + 5, false);
            drawPixel(bx + 5, by + 4, false);
            drawPixel(bx + 5, by + 6, false);

            // Drift tire smoke puff
            const t = animPhase;
            const sx = bx + BOX_W + 1 + ((t + 0) % 5);
            const sy = by + 7 - (Math.floor(t / 2) % 3);
            if (sx <= 125 && sy >= 13 && sy <= 61) drawPixel(sx, sy, true);
          }"""

new_anim = """          if (isCurrentActive && isPressed) {
            // 1. Concentric Radial Shockwave Halo (Expands OUTWARD without slicing other keys!)
            const haloR = 1 + (animPhase % 3);
            drawRect(bx - haloR, by + 1 - haloR, BOX_W + 2 * haloR, 8 + 2 * haloR, true);
            drawPixel(bx - haloR - 2, by + 2, true);
            drawPixel(bx + BOX_W + haloR + 1, by + 2, true);
            drawPixel(bx + BOX_W + haloR + 2, by + 6, true);

            // 2. Mechanical Sinking Keycap: Sinks DOWN 2 pixels (by+2 to by+8)
            fillRect(bx, by + 2, BOX_W, 7, true);
            drawPixel(bx, by + 2, false);
            drawPixel(bx + BOX_W - 1, by + 2, false);
            drawPixel(bx, by + 8, false);
            drawPixel(bx + BOX_W - 1, by + 8, false);

            // Inverted Center Diamond Crosshair
            drawPixel(bx + 5, by + 5, false);
            drawPixel(bx + 4, by + 5, false);
            drawPixel(bx + 6, by + 5, false);
            drawPixel(bx + 5, by + 4, false);
            drawPixel(bx + 5, by + 6, false);
          }"""

assert old_anim in c, "old_anim not found"
c = c.replace(old_anim, new_anim)

with open(path, "w", encoding="utf-8") as f:
    f.write(c)

print("home_screen_designer.html updated perfectly!")
