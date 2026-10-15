import React, { useEffect, useRef, useState } from 'react';
import { X, Download, ExternalLink, Usb, CheckCircle2 } from 'lucide-react';
import type { FirmwareInstallResult } from '../types/desktop';

interface FlashFirmwareModalProps {
  isOpen: boolean;
  onClose: () => void;
}
export const FlashFirmwareModal: React.FC<FlashFirmwareModalProps> = ({ isOpen, onClose }) => {
  const [firmwareUrl, setFirmwareUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<FirmwareInstallResult | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const desktop = window.driftpadDesktop;

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setFirmwareUrl(null);
    setLoading(true);
    setResult(null);
    const load = async () => {
      try {
        const response = await fetch('./driftpad.uf2', { signal: controller.signal });
        if (!response.ok) throw new Error('No bundled firmware');
        const bytes = await response.arrayBuffer();
        const view = new DataView(bytes);
        if (!bytes.byteLength || bytes.byteLength % 512 !== 0) throw new Error('Invalid firmware');
        for (let offset = 0; offset < bytes.byteLength; offset += 512) {
          if (view.getUint32(offset, true) !== 0x0a324655 ||
              view.getUint32(offset + 4, true) !== 0x9e5d5157 ||
              view.getUint32(offset + 28, true) !== 0xe48bff56 ||
              view.getUint32(offset + 508, true) !== 0x0ab16f30) throw new Error('Invalid firmware');
        }
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        setFirmwareUrl(objectUrl);
      } catch {
        if (!controller.signal.aborted) setFirmwareUrl(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isOpen]);

  const install = async () => {
    if (!desktop || installing) return;
    setInstalling(true);
    setResult(null);
    try { setResult(await desktop.installFirmware()); }
    catch { setResult({ status: 'error', message: 'The copy could not be confirmed. Reconnect in BOOTSEL mode and try again.' }); }
    finally { setInstalling(false); }
  };

  if (!isOpen) return null;
  const copied = result?.status === 'copied';
  return (
    <dialog ref={dialogRef} aria-labelledby="firmware-title"
      onCancel={(event) => { event.preventDefault(); if (!installing) onClose(); }}
      className="m-auto p-0 bg-white rounded-2xl w-[calc(100%-2rem)] max-w-lg shadow-2xl text-[#1c282e] max-h-[90vh] overflow-y-auto backdrop:bg-black/60 backdrop:backdrop-blur-sm">
      <div className="flex items-center justify-between p-5 border-b border-[#e5dfd5]">
        <div>
          <h2 id="firmware-title" className="text-lg font-bold">Set up your DriftPad</h2>
          <p className="text-sm text-[#57676e]">Ready-made firmware. No developer tools needed.</p>
        </div>
        <button type="button" onClick={onClose} disabled={installing} aria-label="Close firmware setup"
          className="p-2 rounded-lg hover:bg-[#f5f2eb] disabled:opacity-40"><X className="w-5 h-5" /></button>
      </div>
      <div className="p-5 space-y-5 text-sm">
        <p>Use this for a new pad or a firmware update. Digital Twin works without installing anything on a device.</p>
        <ol className="space-y-4">
          <li className="flex gap-3"><span className="font-bold text-[#9e5b3d]">1</span><div>
            <strong>Plug in while holding BOOTSEL</strong>
            <p className="mt-1 text-[#57676e]">Disconnect in DriftPad and unplug the USB cable first. Hold the Pico’s BOOTSEL button while plugging it back in. Release when the <strong>RPI-RP2</strong> drive appears.</p>
          </div></li>
          <li className="flex gap-3"><span className="font-bold text-[#9e5b3d]">2</span><div>
            <strong>{desktop ? 'Choose the drive and install' : 'Save the firmware and copy it to RPI-RP2'}</strong>
            <p className="mt-1 text-[#57676e]">{desktop
              ? 'Use the button below, select RPI-RP2 under This PC, then choose “Install firmware here”. Keep the cable connected while it copies.'
              : 'Use the Windows app for guided installation, or save the bundled file below and drag it onto the RPI-RP2 drive.'}</p>
          </div></li>
          <li className="flex gap-3"><span className="font-bold text-[#9e5b3d]">3</span><div>
            <strong>Reconnect your pad</strong>
            <p className="mt-1 text-[#57676e]">The drive disappears when the Pico restarts. Close this window, click <strong>Connect USB</strong>, and select your pad. Calibrate with all keys released, then test before enabling HID.</p>
          </div></li>
        </ol>
        <p className="rounded-xl bg-[#f5f2eb] p-3 text-[#57676e]">
          For DriftPad V2 wiring with a Raspberry Pi Pico (RP2040) and SSD1306 display.
          Export your profiles before updating. Pico 2 and SH1106 displays need a different build.
        </p>
        <div aria-live="polite" aria-atomic="true" className="space-y-3">
          {loading ? <p>Checking bundled firmware…</p> : firmwareUrl ? (
            <div className="flex flex-wrap items-center gap-3">
              {desktop && <button type="button" onClick={() => void install()} disabled={installing || copied}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#9e5b3d] text-white font-semibold rounded-xl disabled:opacity-50">
                <Usb className="w-4 h-4" /> {installing ? 'Choosing drive / copying…' : copied ? 'Firmware copied' : 'Choose drive & install'}
              </button>}
              {!installing && <a href={firmwareUrl} download="DriftPad.uf2"
                className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-[#e5dfd5] font-semibold">
                <Download className="w-4 h-4" /> Save UF2 file
              </a>}
            </div>
          ) : <p>This build has no usable bundled firmware. Download the Windows app from the project’s download page below.</p>}
          {result?.status === 'error' && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-800">{result.message}</p>}
          {result?.status === 'cancelled' && <p>No drive selected. Nothing was written.</p>}
          {copied && <div className="rounded-xl bg-green-50 p-3 text-green-900">
            <p className="flex items-center gap-2 font-semibold"><CheckCircle2 className="w-4 h-4" /> Firmware copied to the Pico drive</p>
            <p className="mt-1">Wait for the drive to disappear, then reconnect with Connect USB. The app has not yet verified the running firmware or calibrated the sensors.</p>
            <button type="button" onClick={onClose} className="mt-3 underline font-semibold">Close and reconnect</button>
          </div>}
        </div>
        <details className="text-[#57676e]">
          <summary className="cursor-pointer font-semibold">RPI-RP2 is missing or the copy failed?</summary>
          <p className="mt-2">Use a USB cable that supports data. Unplug the Pico and try again while holding BOOTSEL before inserting the cable. Select the drive itself, not a folder. If the copy reports an error, reconnect in BOOTSEL mode before retrying.</p>
        </details>
        <div className="flex flex-wrap gap-4 text-xs text-[#153641]">
          <a href="https://github.com/The-Osprey1/DriftPad/blob/main/docs/desktop.md" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
            Downloads and setup <ExternalLink className="w-3 h-3" />
          </a>
          <a href="https://github.com/The-Osprey1/DriftPad/blob/main/docs/hardware.md" target="_blank" rel="noreferrer" className="underline">Hardware guide</a>
        </div>
      </div>
    </dialog>
  );
};
