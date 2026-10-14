import React, { useState, useRef, useEffect } from 'react';
import { LogEntry } from '../types/driftpad';
import { Terminal, Send, Trash2, Copy, Check } from 'lucide-react';

interface SerialConsoleProps {
  logs: LogEntry[];
  onSendCommand: (cmd: string) => void;
  onClearLogs: () => void;
}

const COMMON_COMMANDS = [
  'GET_CONFIG',
  'STATUS',
  'PING',
  'STREAM 1',
  'STREAM 0',
  'SCREENSAVER',
  'ANIM 0',
  'ANIM 1',
  'ANIM 2',
  'ANIM 3',
  'ANIM 4',
  'ANIM 5',
  'SAVE',
  'CALIBRATE',
  'FULLSCREEN',
  'OLED_TEST',
  'OLED_SCAN',
  'BOOTSEL',
];

export const SerialConsoleComponent: React.FC<SerialConsoleProps> = ({
  logs,
  onSendCommand,
  onClearLogs,
}) => {
  const [inputVal, setInputVal] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputVal.trim()) {
      onSendCommand(inputVal.trim());
      setInputVal('');
    }
  };

  const handleCopyLogs = () => {
    const text = logs
      .map((l) => `[${l.timestamp}] [${l.direction}] ${l.text}`)
      .join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-2.5 bg-[#faf8f5] p-3.5 rounded-xl border border-[#e5dfd5]">
      <div className="flex justify-between items-center border-b border-[#e5dfd5] pb-2">
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-[#1e3f48]" />
          <span className="text-xs font-bold text-[#1c282e] font-mono">
            USB Serial Console (115200 8N1)
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleCopyLogs}
            className="text-[11px] text-[#57676e] hover:text-[#1c282e] flex items-center gap-1 transition-colors"
            title="Copy logs to clipboard"
          >
            {copied ? <Check className="w-3 h-3 text-[#15803d]" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <button
            onClick={onClearLogs}
            className="text-[11px] text-[#57676e] hover:text-red-600 flex items-center gap-1 transition-colors"
            title="Clear console"
          >
            <Trash2 className="w-3 h-3" />
            <span>Clear</span>
          </button>
        </div>
      </div>

      {/* Terminal log window */}
      <div
        ref={logContainerRef}
        className="h-32 overflow-y-auto font-mono text-[11px] space-y-1 pr-1 select-text scrollbar-thin bg-[#12242b] p-2.5 rounded-xl border border-[#28464f] text-[#e8f1ee]"
      >
        {logs.length === 0 ? (
          <div className="text-[#71938c] italic">No serial communications yet...</div>
        ) : (
          logs.map((log) => {
            let color = 'text-[#e8f1ee]';
            if (log.direction === 'TX') color = 'text-[#71938c]';
            else if (log.direction === 'RX') color = 'text-[#9ed3c7]';
            else if (log.direction === 'ERR') color = 'text-[#e07a5f]';
            else if (log.direction === 'INFO') color = 'text-[#facc15]';

            return (
              <div key={log.id} className="flex gap-2 leading-relaxed">
                <span className="text-[#84949b] shrink-0">[{log.timestamp}]</span>
                <span className="font-bold shrink-0 w-8">{log.direction}</span>
                <span className={`${color} break-all`}>{log.text}</span>
              </div>
            );
          })
        )}
      </div>

      {/* Quick command buttons */}
      <div className="flex gap-1.5 overflow-x-auto py-0.5 scrollbar-none text-[10px]">
        {COMMON_COMMANDS.slice(0, 7).map((cmd) => (
          <button
            key={cmd}
            onClick={() => onSendCommand(cmd)}
            className="bg-[#ffffff] hover:bg-[#faf8f5] text-[#1c282e] hover:text-[#9e5b3d] px-2.5 py-1 rounded-lg border border-[#e5dfd5] font-mono shrink-0 transition-colors shadow-xs font-semibold"
          >
            {cmd}
          </button>
        ))}
      </div>

      {/* Command prompt input */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          placeholder="Send custom serial command (e.g. GET_CONFIG, STATUS)..."
          className="flex-1 bg-[#ffffff] text-[#1c282e] placeholder-[#84949b] px-3 py-1.5 text-xs rounded-xl border border-[#d5ccc0] font-mono focus:outline-none focus:border-[#9e5b3d]"
        />
        <button
          type="submit"
          className="bg-[#9e5b3d] hover:bg-[#8b4e34] text-white px-3.5 py-1.5 rounded-xl border border-[#9e5b3d] text-xs font-mono font-bold flex items-center gap-1.5 transition-colors shadow-xs"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Send</span>
        </button>
      </form>
    </div>
  );
};

export const SerialConsole = React.memo(SerialConsoleComponent);
