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

export const SerialConsole: React.FC<SerialConsoleProps> = ({
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
    <div className="flex flex-col gap-2.5 bg-[#090b10] p-3.5 rounded-xl border border-[#2d3748]">
      <div className="flex justify-between items-center border-b border-[#2d3748] pb-2">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-[#10b981]" />
          <span className="text-xs font-bold text-gray-300 uppercase tracking-wider font-mono">
            USB Serial Console (115200 8N1)
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleCopyLogs}
            className="text-[11px] text-gray-400 hover:text-white flex items-center gap-1 transition-colors"
            title="Copy logs to clipboard"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <button
            onClick={onClearLogs}
            className="text-[11px] text-gray-400 hover:text-red-400 flex items-center gap-1 transition-colors"
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
        className="h-32 overflow-y-auto font-mono text-[11px] space-y-1 pr-1 select-text scrollbar-thin"
      >
        {logs.length === 0 ? (
          <div className="text-gray-600 italic">No serial communications yet...</div>
        ) : (
          logs.map((log) => {
            let color = 'text-gray-300';
            if (log.direction === 'TX') color = 'text-[#00f2fe]';
            else if (log.direction === 'RX') color = 'text-emerald-400';
            else if (log.direction === 'ERR') color = 'text-red-400';
            else if (log.direction === 'INFO') color = 'text-amber-400';

            return (
              <div key={log.id} className="flex gap-2 leading-relaxed">
                <span className="text-gray-500 shrink-0">[{log.timestamp}]</span>
                <span className="font-bold shrink-0 w-8">{log.direction}</span>
                <span className={`${color} break-all`}>{log.text}</span>
              </div>
            );
          })
        )}
      </div>

      {/* Quick command buttons */}
      <div className="flex gap-1.5 overflow-x-auto py-1 scrollbar-none text-[10px]">
        {COMMON_COMMANDS.slice(0, 7).map((cmd) => (
          <button
            key={cmd}
            onClick={() => onSendCommand(cmd)}
            className="bg-[#181c27] hover:bg-[#222738] text-gray-300 hover:text-[#00f2fe] px-2 py-0.5 rounded border border-[#2d3748] font-mono shrink-0 transition-colors"
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
          className="flex-1 bg-[#181c27] text-white placeholder-gray-500 px-3 py-1.5 text-xs rounded-lg border border-[#2d3748] font-mono focus:outline-none focus:border-[#00f2fe]"
        />
        <button
          type="submit"
          className="bg-[#222738] hover:bg-[#2d3748] text-[#00f2fe] px-3 py-1.5 rounded-lg border border-[#2d3748] text-xs font-mono font-bold flex items-center gap-1 transition-colors"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Send</span>
        </button>
      </form>
    </div>
  );
};
