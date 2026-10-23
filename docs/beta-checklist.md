# External beta checklist

A build is offered to people outside the project only when every line below is true **for that exact
build**. The automated half is one command; the hardware half is a signed acceptance record. Nothing
in this repository publishes, tags or uploads anything; that is a separate, deliberate step.

## Software (automated, no hardware)

- [ ] Clean checkout of the commit to release (`git status` empty, untracked files included).
- [ ] `python tools/qualify_release.py` ends "qualified" (clean tree, version with a CHANGELOG
      section, toolchain equal to `firmware/toolchain.lock.json`, every suite in release mode with a
      fresh build, UF2/ELF/manifest checked). Keep `dist/driftpad-<version>-<build>/` and its
      `SHA256SUMS`.
- [ ] CI is green on the same commit on both Ubuntu 24.04 and Windows Server 2022 (same release
      test command and locked firmware toolchain on each runner).
- [ ] The bundle's `RELEASE.md` counts show no skipped test and no failed test.
- [ ] `CHANGELOG.md` states compatibility and migration for this version.

## Hardware (needs a pad)

- [ ] Every required item of [hardware-acceptance.md](hardware-acceptance.md) passed on real
      hardware with this build, and `python tools/acceptance_record.py check` reports nothing open.
- [ ] The record is signed (`acceptance_record.py sign`) and `qualify_release.py --acceptance` marks
      the bundle ready.
- [ ] Any unavailable optional item (HW-09, HW-21, HW-33) is marked `n/a` with a reason in the
      signed record and mentioned in the beta notes. An optional item marked `fail` still blocks
      sign-off.

## Assets that do not exist yet

The repository has no PCB or enclosure files (`hardware/kicad/`, `hardware/mechanical/` are
placeholders), no BOM, no assembly guide and no photographs of a built pad. Beta testers with their
own boards need at least: the schematic and gerbers, the BOM with the Hall sensor part number and
magnet polarity, the enclosure STL/STEP, an assembly and first-power-on guide, and a photo of the
finished pad next to the OLED screenshots. Until they are published, the beta is limited to people who
already hold a working pad.

## Beta hygiene

- [ ] Beta notes say: what is new, how to update (`tools/flash.py`), how to go back (previous UF2
      with `flash.py --allow-downgrade`; saved settings are kept in the A/B slots), what to report,
      and that keyboard output is off until the pad is calibrated.
- [ ] A way to report problems, with `INFO`, `TIMING` and the configurator's diagnostics attached.
- [ ] Known limits from [testing.md](testing.md) section 7 and the CHANGELOG are repeated in the
      notes; nothing in the notes says "tested on hardware" for anything not in the signed record.

## Next step before beta

Build the pad, run `python tools/qualify_release.py`, then work through
[hardware-acceptance.md](hardware-acceptance.md) from HW-01 with the bundle's firmware.
