// WebSerial communication manager for DriftPad

// Minimal WebSerial types for browser
interface SerialPort {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

interface NavigatorWithSerial {
  serial?: {
    requestPort: () => Promise<SerialPort>;
    getPorts: () => Promise<SerialPort[]>;
  };
}

export type ConnectionMode = 'disconnected' | 'hardware' | 'virtual';

export class SerialService {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private writer: WritableStreamDefaultWriter<string> | null = null;
  private isConnecting: boolean = false;
  private keepReading: boolean = false;
  private readLoopTask: Promise<void> | null = null;
  private decoderPipeTask: Promise<void> | null = null;
  private encoderPipeTask: Promise<void> | null = null;

  private onLineReceivedCb?: (line: string) => void;
  private onLineSentCb?: (line: string) => void;
  private onStatusChangeCb?: (mode: ConnectionMode) => void;
  private onLogCb?: (direction: 'TX' | 'RX' | 'INFO' | 'ERR', text: string) => void;

  public isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  public setCallbacks(cbs: {
    onLineReceived?: (line: string) => void;
    onLineSent?: (line: string) => void;
    onStatusChange?: (mode: ConnectionMode) => void;
    onLog?: (direction: 'TX' | 'RX' | 'INFO' | 'ERR', text: string) => void;
  }) {
    this.onLineReceivedCb = cbs.onLineReceived;
    this.onLineSentCb = cbs.onLineSent;
    this.onStatusChangeCb = cbs.onStatusChange;
    this.onLogCb = cbs.onLog;
  }

  public isConnected(): boolean {
    return this.port !== null;
  }

  public async connectHardware(): Promise<boolean> {
    const nav = navigator as unknown as NavigatorWithSerial;
    if (!nav.serial) {
      this.onLogCb?.('ERR', 'WebSerial API is not supported in this browser. Please use Chrome, Edge, or Opera.');
      return false;
    }

    if (this.isConnecting) return false;
    this.isConnecting = true;

    try {
      this.port = await nav.serial.requestPort();
      await this.port.open({ baudRate: 115200 });

      if (this.port.readable && this.port.writable) {
        const textDecoder = new TextDecoderStream();
        this.decoderPipeTask = (this.port.readable as unknown as ReadableStream<BufferSource>)
          .pipeTo(textDecoder.writable)
          .catch((err) => {
            if (this.keepReading) {
              this.onLogCb?.('ERR', `Serial decoder stopped: ${String(err)}`);
            }
          });
        this.reader = textDecoder.readable.getReader();

        const textEncoder = new TextEncoderStream();
        this.encoderPipeTask = textEncoder.readable
          .pipeTo(this.port.writable as unknown as WritableStream<Uint8Array>)
          .catch((err) => {
            if (this.keepReading) {
              this.onLogCb?.('ERR', `Serial encoder stopped: ${String(err)}`);
            }
          });
        this.writer = textEncoder.writable.getWriter();

        this.keepReading = true;
        this.readLoopTask = this.startReadLoop();

        this.onStatusChangeCb?.('hardware');
        this.onLogCb?.('INFO', 'Connected to DriftPad USB Serial at 115200 baud.');

        // Initial sync
        await this.sendCommand('GET_CONFIG');
        return true;
      }
      await this.disconnect();
      return false;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onLogCb?.('ERR', `Connection failed: ${msg}`);
      await this.disconnect();
      return false;
    } finally {
      this.isConnecting = false;
    }
  }

  public async disconnect(): Promise<void> {
    this.keepReading = false;
    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
        this.reader = null;
      }
      if (this.writer) {
        await this.writer.close();
        this.writer.releaseLock();
        this.writer = null;
      }
      if (this.port) {
        await this.port.close();
        this.port = null;
      }
    } catch (err) {
      this.onLogCb?.('ERR', `Disconnect error: ${String(err)}`);
    }
    await Promise.allSettled(
      [this.readLoopTask, this.decoderPipeTask, this.encoderPipeTask].filter(
        (task): task is Promise<void> => task !== null
      )
    );
    this.readLoopTask = null;
    this.decoderPipeTask = null;
    this.encoderPipeTask = null;
    this.port = null;
    this.onStatusChangeCb?.('disconnected');
    this.onLogCb?.('INFO', 'Disconnected from serial device.');
  }

  public async sendCommand(cmd: string): Promise<boolean> {
    if (!this.writer) return false;
    try {
      const cleanCmd = cmd.trim();
      await this.writer.write(cleanCmd + '\n');
      this.onLineSentCb?.(cleanCmd);
      this.onLogCb?.('TX', cleanCmd);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onLogCb?.('ERR', `Write error: ${msg}`);
      return false;
    }
  }

  private async startReadLoop(): Promise<void> {
    let buffer = '';
    try {
      while (this.keepReading && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              this.onLineReceivedCb?.(trimmed);
              this.onLogCb?.('RX', trimmed);
            }
          }
        }
      }
    } catch (err: unknown) {
      if (this.keepReading) {
        const msg = err instanceof Error ? err.message : String(err);
        this.onLogCb?.('ERR', `Serial read error: ${msg}`);
      }
    }
    if (this.keepReading) {
      this.keepReading = false;
      this.port = null;
      this.onStatusChangeCb?.('disconnected');
      this.onLogCb?.('ERR', 'Serial device stopped sending data.');
    }
  }
}
