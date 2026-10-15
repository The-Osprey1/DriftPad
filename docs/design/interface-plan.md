> Historical design plan, preserved from the original AI Studio workspace.
> This records design intent; it is not a verification of the current UI.

# DriftPad 2D Chassis Layout, OLED Palette & UI Streamlining

Refine the DriftPad interface into a cohesive 2D hardware chassis representation, fix tooltip edge-overflow issues, enforce the authentic Soft & Coastal palette on the live OLED canvas, and declutter visual telemetry.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following decisions were confirmed with the user during Phase 1 clarification:
> - **Chassis Layout**: An integrated 2D hardware enclosure featuring the OLED live display and rotary encoder knob positioned directly above the 4x4 tactile key matrix.
> - **OLED Color Palette**: Strict Soft & Coastal theme (`#12242b` dark teal background, `#e8f1ee` cream display text, `#71938c` seaglass graph lines, `#e07a5f` terracotta accents).
> - **Layout Streamlining**: High signal-to-noise ratio: remove raw baud/pin telemetry clutter from standard view, keeping only actionable, clear controls and clean typography.

---

## 1. Overview & Core Concept

DriftPad is a high-performance Hall-effect macropad with continuous Rapid Trigger sensing, an integrated SSD1306 OLED screen, and a multi-function rotary knob. 

This update resolves layout and styling discrepancies:
1. **Physical 2D Pad Representation**: Instead of separating the 4x4 key matrix and OLED screen into disjointed columns, the primary view will present a unified 2D physical chassis reflecting the true hardware layout (OLED screen + rotary dial mounted directly above the 4x4 key matrix).
2. **Edge-Safe Tooltips**: Fix `HoverExplain` popovers to dynamically detect container and viewport boundaries so they never clip or spill beyond screen edges.
3. **True Soft & Coastal OLED Display**: Ensure the canvas rendering engine and mini-previews strictly adhere to the warm, high-contrast Soft & Coastal palette.
4. **Decluttered Editorial Typography**: Eliminate non-essential technical boilerplate (e.g. `115200 8N1`, redundant status badges, and decorative code noise) in favor of crisp, useful controls.

---

## 2. User Experience & Visual Design

### Physical 2D Chassis Anatomy
```
┌─────────────────────────────────────────────────────────────┐
│                    DRIFTPAD PHYSICAL CHASSIS                │
│ ┌──────────────────────────────────┐   ┌──────────────────┐ │
│ │  OLED Cockpit Screen (128x64)    │   │  Rotary Encoder  │ │
│ │  [#12242b Teal Canvas]           │   │  Knurled Dial    │ │
│ │  Live Analog Graph & Workspace   │   │  CW / CCW / Push │ │
│ └──────────────────────────────────┘   └──────────────────┘ │
│ ─────────────────────────────────────────────────────────── │
│ ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   │
│ │   ESC    │   │    7     │   │    8     │   │    9     │   │
│ └──────────┘   └──────────┘   └──────────┘   └──────────┘   │
│ ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   │
│ │    /     │   │    4     │   │    5     │   │    6     │   │
│ └──────────┘   └──────────┘   └──────────┘   └──────────┘   │
│ ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   │
│ │    *     │   │    1     │   │    2     │   │    3     │   │
│ └──────────┘   └──────────┘   └──────────┘   └──────────┘   │
│ ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   │
│ │    -     │   │    +     │   │    0     │   │   ENT    │   │
│ └──────────┘   └──────────┘   └──────────┘   └──────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Visual Identity & Theme
- **Base Surface**: Light warm cream `#f5f2eb` canvas with crisp `#ffffff` cards and `#e5dfd5` hairline borders.
- **OLED Live Screen**:
  - Background: `#12242b` (Deep coastal slate teal)
  - Text: `#e8f1ee` (High-contrast soft cream)
  - Graphing: `#71938c` (Seaglass green)
  - Accents / Actuation Line: `#e07a5f` (Terracotta)
  - Grid / Dim Elements: `#28464f` (Muted ocean slate)
- **Chassis Enclosure**: Soft chamfered hardware bezel (`bg-[#ede8df]` with subtle inner shadow and perimeter border `#d5ccc0`) providing an authentic tactile desktop feel.
- **Keycaps**: Clean matte keys with bottom-up travel bars, active press states in terracotta (`#9e5b3d`), and subtle elevation shadows.

### Edge-Safe Popovers
- `HoverExplain` updated with smart horizontal clamping:
  - Detects if trigger is close to viewport edges (`left < 160px` or `right > window.innerWidth - 160px`).
  - Automatically shifts alignment to `left-0`, `right-0`, or centered, with a `max-w-[calc(100vw-2rem)]` safety fence.
  - Ensures tooltips never generate horizontal scrollbars or vanish off-screen.

---

## 3. Key Product Decisions & Trade-Offs

- **Integrated Pad View vs. Split Deck**:
  - *Chosen Approach*: Group the OLED display, rotary knob, and 16-key pad together inside the physical hardware chassis container on the primary panel. Secondary tuning sliders (actuation depth, rapid trigger sensitivity, and USB serial logs) sit in an adjacent or collapsible inspection deck.
  - *Why*: Reflects the real 2D physical device that users interact with on their desk, matching mental models.
- **Decluttering Telemetry**:
  - *Chosen Approach*: Move low-level microcontroller pinouts and baud rates exclusively into the **Hardware Specs Modal** (`HardwareInfoModal.tsx`).
  - *Why*: Daily users care about active key travel, workspace assignments, and trigger response—not pin multiplexer multiplexing details.
- **Default OLED Theme Hardening**:
  - *Chosen Approach*: Enforce `SOFT_COASTAL_OLED_THEME` as the single authoritative default for both new sessions and loaded profiles that lack a custom palette.

---

## 4. Technical Architecture & Component Hierarchy

```
┌──────────────────────────────────────────────────────────────────┐
│                             App.tsx                              │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │               Header.tsx (Clean 3-Zone Bar)                  │ │
│ │   [Wordmark & Workspace]  ──  [Flash | Connect | Save]       │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌─────────────────────────────────┐  ┌─────────────────────────┐ │
│ │     Hardware Chassis Panel      │  │    Inspection Deck      │ │
│ │ ┌─────────────┐ ┌─────────────┐ │  │ ┌─────────────────────┐ │ │
│ │ │ OledCanvas  │ │ RotaryDial  │ │  │ │ RapidTriggerTuning  │ │ │
│ │ └─────────────┘ └─────────────┘ │  │ └─────────────────────┘ │ │
│ │ ┌─────────────────────────────┐ │  │ ┌─────────────────────┐ │ │
│ │ │  KeyMatrix (4x4 Grid)       │ │  │ │ Key Inspector       │ │ │
│ │ └─────────────────────────────┘ │  │ └─────────────────────┘ │ │
│ └─────────────────────────────────┘  └─────────────────────────┘ │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Modals: FlashFirmwareModal · RemapModal · OledThemeModal     │ │
│ └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### Components to Update
1. **`src/components/HoverExplain.tsx`**: Add dynamic viewport boundary clamping (`getBoundingClientRect` check or responsive classes) so popover cards remain within the viewport.
2. **`src/components/OledCanvas.tsx`**: Harmonize canvas rendering (`renderProductivity`, `renderCockpit`) with `SOFT_COASTAL_OLED_THEME` colors; streamline display text.
3. **`src/components/KeyMatrix.tsx`**: Optimize 4x4 button layout and sizing to integrate seamlessly under the top OLED/knob deck.
4. **`src/App.tsx`**: Restructure layout into the unified 2D Hardware Chassis (OLED + Dial + 4x4 Grid in physical enclosure) alongside the streamlined tuning deck.
5. **`src/components/Header.tsx`**: Remove redundant subtitle text (`115200 8N1`, `RP2040 Hall-Effect...`) keeping only clean, essential controls.
