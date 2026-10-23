export type FirmwareInstallResult =
  | { status: 'copied' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

declare global {
  interface Window {
    driftpadDesktop?: {
      installFirmware: () => Promise<FirmwareInstallResult>;
    };
  }
}
