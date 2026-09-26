path = r"C:\Users\devyn\.gemini\antigravity\brain\5718f2fc-a709-431c-bfa8-22edc30be32b\home_screen_designer.html"
with open(path, "r", encoding="utf-8") as f:
    c = f.read()

c = c.replace("\r\n", "\n")

old_pill = '      drawText("L0:RT", 93, 2, 1, true);'
new_pill = '''      const pillStr = "L0:RT";
      const pillTextW = pillStr.length * 6 - 1;
      const pillTextX = 87 + Math.floor((40 - pillTextW) / 2);
      drawText(pillStr, pillTextX, 2, 1, true);'''

assert old_pill in c, "old_pill not found"
c = c.replace(old_pill, new_pill)

old_halo = """            const haloR = 1 + (animPhase % 3);
            drawRect(bx - haloR, by + 1 - haloR, BOX_W + 2 * haloR, 8 + 2 * haloR, true);
            drawPixel(bx - haloR - 2, by + 2, true);
            drawPixel(bx + BOX_W + haloR + 1, by + 2, true);
            drawPixel(bx + BOX_W + haloR + 2, by + 6, true);"""

new_halo = """            const haloR = 1; // Radius capped at 1 to prevent touching neighbors
            drawRect(bx - haloR, by + 1 - haloR, BOX_W + 2 * haloR, 8 + 2 * haloR, true);
            if (animPhase % 3 === 0) {
              // Frame 1 only: sparks strictly within 3px gap
              drawPixel(bx - 2, by + 2, true);
              drawPixel(bx + BOX_W + 1, by + 2, true);
            }"""

assert old_halo in c, "old_halo not found"
c = c.replace(old_halo, new_halo)

with open(path, "w", encoding="utf-8") as f:
    f.write(c)

print("home_screen_designer.html synchronized successfully!")
