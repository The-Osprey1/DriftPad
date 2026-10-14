import React, { useEffect, useState } from 'react';
import { X, Download, ExternalLink } from 'lucide-react';

interface FlashFirmwareModalProps {
  isOpen: boolean;
  onClose: () => void;
}
export const FlashFirmwareModal: React.FC<FlashFirmwareModalProps> = ({ isOpen, onClose }) => {
  const [firmwareUrl, setFirmwareUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setFirmwareUrl(null);
    setLoading(true);
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

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <section role="dialog" aria-modal="true" aria-labelledby="firmware-title"
        className="bg-white rounded-2xl w-full max-w-lg shadow-2xl text-[#1c282e] max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-[#e5dfd5]">
          <h2 id="firmware-title" className="text-lg font-bold">Set up your DriftPad</h2>
          <button type="button" onClick={onClose} aria-label="Close firmware setup"
            className="p-2 rounded-lg hover:bg-[#f5f2eb]"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-5 text-sm">
          <p>Already using your pad? You only need this when installing or updating its firmware. Digital Twin works without a device.</p>
          <ol className="list-decimal pl-5 space-y-3">
            <li>Disconnect the pad in DriftPad, then unplug its USB cable.</li>
            <li>Hold the Pico’s <strong>BOOTSEL</strong> button while plugging it in. Release the button when the <strong>RPI-RP2</strong> drive appears.</li>
            <li>Save the firmware below, then drag <strong>DriftPad.uf2</strong> onto the RPI-RP2 drive.</li>
            <li>The drive disappears when the Pico restarts. Return here, click <strong>Connect USB</strong>, and select your pad.</li>
          </ol>
          <p className="rounded-xl bg-[#f5f2eb] p-3">
            This firmware is for the documented DriftPad V2 Raspberry Pi Pico wiring and SSD1306 display.
            Export your profiles before updating. After connecting, calibrate with all keys released and test before enabling HID.
          </p>
          <div aria-live="polite">
            {loading ? <p>Checking bundled firmware…</p> : firmwareUrl ? (
              <a href={firmwareUrl} download="DriftPad.uf2"
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#c86443] text-white font-semibold rounded-xl">
                <Download className="w-4 h-4" /> Save firmware
              </a>
            ) : (
              <p>This build does not include firmware. Use the desktop app download or follow the source-build instructions below.</p>
            )}
          </div>
          <p className="text-xs text-[#57676e]">Saving the file does not flash the device. Copy it to RPI-RP2 to install it.</p>
          <a href="https://github.com/The-Osprey1/DriftPad/blob/main/docs/hardware.md" target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-2 underline text-[#153641]">
            Hardware and wiring guide <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </section>
    </div>
  );
};
