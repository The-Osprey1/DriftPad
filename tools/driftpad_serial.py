"""
driftpad_serial.py - Finding and identifying DriftPads over USB serial (shared by flash.py and
timing_capture.py)

Candidate ports are USB serial ports with the Raspberry Pi vendor id and a product id that
arduino-pico uses. The product ids were taken from framework-arduinopico 6.1.0-4 (fd65f6d4), not
guessed:

* boards.txt, rpipico.pid.0..7 / rpipico.upload_port.N.pid:
  0x000a 0x010a 0x400a 0x410a 0x800a 0x810a 0xc00a 0xc10a
  (tools/makeboards.py: base 0x000a | keyboard 0x8000 | mouse 0x4000 | joystick 0x0100, the
  composite scheme of older cores)
* cores/rp2040/USB.cpp: idProduct = USBD_PID (0x000a) XOR the pidMask of every registered HID
  device: Keyboard.cpp 0x0001, Mouse.cpp/MouseAbsolute.cpp 0x0002, Joystick.cpp 0x0004. A DriftPad
  (CDC + Keyboard) built with this core therefore enumerates as 2E8A:000B.

Identification (contract section 2): `@1 INFO` must return device "DriftPad" and protocol 2. A
protocol-1 firmware answers that line with an id-less `{"status":"error","msg":"Unknown command"}`
and answers `PING` with `{"type":"pong"}`; it is reported as a legacy DriftPad. Anything else is
"not a DriftPad / no response". Replies are matched by request id only; event lines (no "status")
and id-less replies never satisfy a request.

The serial and port-listing layers are injectable so the tools can be tested without hardware.
pyserial is imported only when a real port is used.
"""

import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional

BAUD = 115200
RPI_VID = 0x2E8A
BOARDS_TXT_PIDS = (0x000A, 0x010A, 0x400A, 0x410A, 0x800A, 0x810A, 0xC00A, 0xC10A)
USB_CPP_BASE_PID = 0x000A
USB_CPP_PID_MASKS = (0x0001, 0x0002, 0x0004)   # keyboard, mouse, joystick
DRIFTPAD_PID = USB_CPP_BASE_PID ^ 0x0001       # CDC + Keyboard

INFO_TIMEOUT_S = 0.8
PING_TIMEOUT_S = 0.8
REQUEST_TIMEOUT_S = 2.0
READ_TIMEOUT_S = 0.05


def arduino_pico_pids() -> frozenset:
    pids = set(BOARDS_TXT_PIDS)
    for combo in range(1 << len(USB_CPP_PID_MASKS)):
        mask = 0
        for bit, m in enumerate(USB_CPP_PID_MASKS):
            if combo & (1 << bit):
                mask |= m
        pids.add(USB_CPP_BASE_PID ^ mask)
    return frozenset(pids)


ARDUINO_PICO_PIDS = arduino_pico_pids()


@dataclass
class PortInfo:
    device: str
    vid: Optional[int] = None
    pid: Optional[int] = None
    serial_number: Optional[str] = None
    description: str = ""

    def usb_id(self) -> str:
        if self.vid is None or self.pid is None:
            return "no USB id"
        return f"{self.vid:04X}:{self.pid:04X}"


def list_serial_ports() -> List[PortInfo]:
    """All serial ports via pyserial's list_ports."""
    from serial.tools import list_ports  # pyserial, imported lazily
    out = []
    for p in list_ports.comports():
        out.append(PortInfo(device=p.device, vid=p.vid, pid=p.pid,
                            serial_number=p.serial_number, description=p.description or ""))
    return out


def is_candidate(port: PortInfo) -> bool:
    return port.vid == RPI_VID and port.pid in ARDUINO_PICO_PIDS


def candidate_ports(ports: Iterable[PortInfo], any_port: bool = False) -> List[PortInfo]:
    return [p for p in ports if any_port or is_candidate(p)]


def open_serial(device: str, timeout: float = READ_TIMEOUT_S):
    import serial  # pyserial, imported lazily
    return serial.Serial(device, BAUD, timeout=timeout, write_timeout=1.0)


# ----------------------------------------------------------------------------
# Request/reply client
# ----------------------------------------------------------------------------

@dataclass
class Reply:
    obj: Optional[Dict[str, Any]]
    raw: Optional[str]
    elapsed_s: float

    @property
    def ok(self) -> bool:
        return bool(self.obj) and self.obj.get("status") == "ok"


class DeviceClient:
    """Line protocol over a pyserial-like link (write(bytes), readline() -> bytes, close())."""

    def __init__(self, link, clock: Callable[[], float] = time.monotonic):
        self.link = link
        self.clock = clock
        self._next_id = 1
        self.unmatched: List[Dict[str, Any]] = []    # events and replies that matched no request
        self.transcript: List[str] = []              # "> sent" / "< received" lines

    def next_id(self) -> str:
        rid = str(self._next_id)
        self._next_id += 1
        return rid

    def send_line(self, text: str) -> None:
        self.transcript.append("> " + text)
        self.link.write((text + "\n").encode("ascii"))
        flush = getattr(self.link, "flush", None)
        if flush:
            flush()

    def read_line(self) -> Optional[str]:
        raw = self.link.readline()
        if not raw:
            return None
        text = raw.decode("utf-8", errors="replace").strip()
        if text:
            self.transcript.append("< " + text)
        return text or None

    def discard_input(self) -> None:
        reset = getattr(self.link, "reset_input_buffer", None)
        if reset:
            reset()

    @staticmethod
    def parse(line: str) -> Optional[Dict[str, Any]]:
        try:
            obj = json.loads(line)
        except ValueError:
            return None
        return obj if isinstance(obj, dict) else None

    def request(self, command: str, timeout: float = REQUEST_TIMEOUT_S,
                abort_if: Optional[Callable[[Dict[str, Any]], bool]] = None,
                on_line: Optional[Callable[[str, Optional[Dict[str, Any]]], None]] = None) -> Reply:
        """Sends `@<id> command` and waits for the reply carrying that id."""
        rid = self.next_id()
        start = self.clock()
        self.send_line(f"@{rid} {command}")
        while self.clock() - start < timeout:
            line = self.read_line()
            if line is None:
                continue
            obj = self.parse(line)
            if on_line:
                on_line(line, obj)
            if obj is not None and "status" in obj and obj.get("id") == rid:
                return Reply(obj, line, self.clock() - start)
            if obj is not None:
                self.unmatched.append(obj)
                if abort_if and abort_if(obj):
                    break
        return Reply(None, None, self.clock() - start)

    def request_legacy(self, command: str, want: Callable[[Dict[str, Any]], bool],
                       timeout: float = REQUEST_TIMEOUT_S) -> Reply:
        """Protocol 1 has no request ids: send the bare command and take the first line `want` accepts."""
        start = self.clock()
        self.send_line(command)
        while self.clock() - start < timeout:
            line = self.read_line()
            if line is None:
                continue
            obj = self.parse(line)
            if obj is not None and want(obj):
                return Reply(obj, line, self.clock() - start)
            if obj is not None:
                self.unmatched.append(obj)
        return Reply(None, None, self.clock() - start)

    def close(self) -> None:
        try:
            self.link.close()
        except Exception:
            pass


# ----------------------------------------------------------------------------
# Identification
# ----------------------------------------------------------------------------

DRIFTPAD, LEGACY, UNSUPPORTED, NONE, BUSY = "driftpad", "legacy", "unsupported", "none", "busy"


@dataclass
class Identity:
    port: PortInfo
    kind: str
    detail: str
    info: Optional[Dict[str, Any]] = None
    extra: Dict[str, Any] = field(default_factory=dict)

    @property
    def is_driftpad(self) -> bool:
        return self.kind in (DRIFTPAD, LEGACY)

    @property
    def protocol(self) -> Optional[int]:
        if self.kind == LEGACY:
            return 1
        return (self.info or {}).get("protocol")

    @property
    def fw(self) -> Optional[str]:
        return (self.info or {}).get("fw")

    @property
    def build(self) -> Optional[str]:
        return (self.info or {}).get("build")

    def describe(self) -> str:
        head = f"{self.port.device} [{self.port.usb_id()}"
        head += f", serial {self.port.serial_number}]" if self.port.serial_number else "]"
        if self.kind == DRIFTPAD:
            i = self.info or {}
            settings = i.get("settings") or {}
            cal = i.get("calibration") or {}
            return (f"{head} {i.get('device')} ({i.get('hw')}) fw {i.get('fw')} build {i.get('build')} "
                    f"protocol {i.get('protocol')}, calibration {cal.get('state')}, settings "
                    f"{settings.get('source')} seq {settings.get('seq')}"
                    f"{' (UNSAVED CHANGES)' if settings.get('dirty') else ''}")
        return f"{head} {self.detail}"


def identify_client(client: DeviceClient, port: PortInfo,
                    info_timeout: float = INFO_TIMEOUT_S, ping_timeout: float = PING_TIMEOUT_S) -> Identity:
    client.discard_input()
    # A protocol-1 firmware answers "@1 INFO" at once with an id-less error; stop waiting then
    reply = client.request("INFO", timeout=info_timeout,
                           abort_if=lambda o: "status" in o and "id" not in o)
    if reply.obj is not None:
        o = reply.obj
        if o.get("status") == "ok" and o.get("device") == "DriftPad" and o.get("protocol") == 2:
            return Identity(port, DRIFTPAD, "DriftPad (protocol 2)", info=o)
        if o.get("status") == "ok" and o.get("device") == "DriftPad":
            return Identity(port, UNSUPPORTED, f"DriftPad with unsupported protocol {o.get('protocol')}", info=o)
        return Identity(port, UNSUPPORTED, "answers INFO but is not a DriftPad", info=o)

    pong = client.request_legacy("PING", want=lambda o: o.get("type") == "pong", timeout=ping_timeout)
    if pong.obj is not None:
        if "cmd" in pong.obj or "status" in pong.obj:
            return Identity(port, UNSUPPORTED, "answers PING like protocol 2 but not INFO")
        return Identity(port, LEGACY, "DriftPad with legacy firmware (protocol 1): update firmware")
    return Identity(port, NONE, "Not a DriftPad / no response")


def identify_port(port: PortInfo, opener: Callable[[str], Any] = open_serial,
                  clock: Callable[[], float] = time.monotonic, **timeouts) -> Identity:
    try:
        link = opener(port.device)
    except Exception as e:  # busy port, permissions, vanished device
        return Identity(port, BUSY, f"cannot open ({e}); is the configurator or a serial monitor using it?")
    client = DeviceClient(link, clock)
    try:
        return identify_client(client, port, **timeouts)
    finally:
        client.close()


@dataclass
class Selection:
    chosen: Optional[Identity]
    identities: List[Identity]
    error: Optional[str] = None


def select_device(list_ports: Callable[[], List[PortInfo]], opener: Callable[[str], Any],
                  port: Optional[str] = None, any_port: bool = False,
                  clock: Callable[[], float] = time.monotonic, allow_legacy: bool = True) -> Selection:
    """Identifies candidate ports and picks exactly one DriftPad (or the one named by `port`)."""
    ports = list_ports()
    if port:
        named = [p for p in ports if p.device == port] or [PortInfo(device=port)]
        ident = identify_port(named[0], opener, clock)
        if not ident.is_driftpad:
            return Selection(None, [ident], f"{port}: {ident.detail}")
        if ident.kind == LEGACY and not allow_legacy:
            return Selection(None, [ident], f"{port}: {ident.detail}")
        return Selection(ident, [ident])

    idents = [identify_port(p, opener, clock) for p in candidate_ports(ports, any_port)]
    pads = [i for i in idents if i.is_driftpad and (allow_legacy or i.kind == DRIFTPAD)]
    if not pads:
        return Selection(None, idents, "no DriftPad found" + ("" if idents else " (no candidate serial ports)"))
    if len(pads) > 1:
        return Selection(None, idents, f"{len(pads)} DriftPads connected ("
                         + ", ".join(i.port.device for i in pads) + "); choose one with --port")
    return Selection(pads[0], idents)
