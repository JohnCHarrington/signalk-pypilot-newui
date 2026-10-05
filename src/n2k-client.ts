import { EventEmitter } from "events";
import * as fs from "fs";
import { PypilotCatalog } from "./pypilot-client";
import { PilotLink } from "./pilot-link";

// pypilot over NMEA 2000, with the control schema of pypilot's N2K bridge
// (pypilot docs/n2k-control.md), through Signal K's NMEA 2000 connection:
//
//   A. 126208 commands to 127237 Heading/Track Control: engage, standby
//      and the heading to steer (pypilot n2k.control 'steer').
//   B. 127502 presses of pypilot's switch bank: engage in a mode, +-1/+-10,
//      tack and jog ('steer' and n2k.switch.bank set).
//   C. 'PP:' text commands in 126998 for every other value: reads
//      ('monitor') and writes ('full'), and the catalog, read in chunks
//      from pypilot's 'values'.
//
// Values come from pypilot's 127237 and 127501 broadcasts where those carry
// them, and otherwise from 'PP:' reads at each watch's period. Reads are
// sent one at a time and rate limited, so a full UI stays within a modest
// share of the bus: when more is watched than fits, every watch slows down.

export interface N2KClientOpts {
  /** the Signal K server: an event emitter for N2K in and out, with getPath */
  app: any;
  /** pypilot's N2K address, found automatically if not set */
  address?: number | null;
  /** where to keep the catalog between runs, so a restart doesn't wait for it */
  catalogCachePath?: string;
  /** most 'PP:' requests a second (each is about 20 frames) */
  maxRequestsPerSecond?: number;
  log?: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
}

const CH_STANDBY = 1;
const CH_MODES: Record<string, number> = { compass: 2, gps: 3, nav: 4, wind: 5, "true wind": 6 };
const CH_MINUS1 = 7, CH_PLUS1 = 8, CH_MINUS10 = 9, CH_PLUS10 = 10;
const CH_TACK = 11, CH_TACK_PORT = 12, CH_TACK_STARBOARD = 13;
const CH_JOG_PORT = 14, CH_JOG_STARBOARD = 15;

const STEERING_MAIN = 0, STEERING_HEADING = 4, STEERING_TRACK = 5;
const STEERING_NAMES: Record<string, number> = {
  "Main Steering": 0, "Non-Follow-Up Device": 1, "Follow-Up Device": 2,
  "Heading Control Standalone": 3, "Heading Control": 4, "Track Control": 5,
};

const OFFLINE_MS = 5000;          // pypilot sends 127237 at 1 Hz
const READ_TIMEOUT_MS = 2500;     // pypilot answers reads within 2 s
const WRITE_TIMEOUT_MS = 1500;    // and writes within 0.5 s
const SETTINGS_PERIOD_S = 30;     // pypilot's n2k.control and n2k.switch.bank
const MAX_PRESSES = 20;
const TICK_MS = 25;

interface Request {
  command: string;
  kind: "read" | "write" | "chunk" | "settings";
  name?: string;
  resolve?: (result: string) => void;
}

// a decoded field by its canboat id, or its name in older servers
function field(evt: any, id: string, name: string): any {
  const f = evt.fields || {};
  return id in f ? f[id] : f[name];
}

function hex(bytes: number[]): string {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, "0")).join(",");
}

function isWind(mode: unknown): boolean {
  return typeof mode === "string" && mode.includes("wind");
}

export class N2KPypilotClient extends EventEmitter implements PilotLink {
  private opts: N2KClientOpts;
  private address: number | null;
  private lastHeard = 0;
  private online = false;
  private running = false;
  private allowWrites = true;
  private timer: NodeJS.Timeout | null = null;

  private catalog: PypilotCatalog = {};
  private lastValues: Record<string, unknown> = {};
  private lastJson: Record<string, string> = {};
  // name -> period (s) and when it's next due
  private watches = new Map<string, { period: number; due: number }>();
  // values carried by pypilot's broadcasts: name -> when last received
  private fedAt: Record<string, number> = {};

  // pypilot's control settings, read with PP:
  private bank: number | null = null;
  private settingsDue = 0;

  // 'PP:' requests: writes first, one outstanding
  private writes: Request[] = [];
  private current: (Request & { tag: string; sent: number; timeout: number }) | null = null;
  private lastSent = 0;
  private tagCount = 0;

  // catalog read in chunks of pypilot's 'values'
  private catalogText = "";
  private catalogTotal = -1;
  private catalogLoading = false;

  private pendingTackDirection: string | null = null;
  private onN2K = (evt: any) => this.receive(evt);

  constructor(opts: N2KClientOpts) {
    super();
    this.opts = opts;
    this.address = typeof opts.address === "number" ? opts.address : null;
  }

  private log(level: "debug" | "info" | "warn" | "error", msg: string): void {
    (this.opts.log || (() => {}))(level, `[pypilot n2k] ${msg}`);
  }

  get connected(): boolean {
    return this.online;
  }

  get healthy(): boolean {
    return this.online && Date.now() - this.lastHeard <= OFFLINE_MS;
  }

  setAllowWrites(v: boolean): void {
    this.allowWrites = !!v;
  }

  getCatalog(): PypilotCatalog {
    return this.catalog;
  }

  getValues(): Record<string, unknown> {
    return this.lastValues;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.opts.app.on("N2KAnalyzerOut", this.onN2K);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.log("info", "looking for pypilot on NMEA 2000");
  }

  stop(): void {
    this.pause();
    this.watches.clear();
    this.catalog = {};
    this.lastValues = {};
    this.lastJson = {};
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.opts.app.removeListener("N2KAnalyzerOut", this.onN2K);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.writes = [];
    this.current = null;
    if (this.online) {
      this.online = false;
      this.emit("disconnect", "paused");
    }
  }

  resume(): void {
    this.start();
  }

  watch(name: string, period: true | number | false = true): void {
    if (period === false) {
      this.watches.delete(name);
      return;
    }
    const p = period === true ? 0.5 : Math.max(0.1, period);
    const existing = this.watches.get(name);
    this.watches.set(name, { period: p, due: existing ? Math.min(existing.due, Date.now() + p * 1000) : 0 });
  }

  // ---- writes ------------------------------------------------------------

  set(name: string, value: unknown): boolean {
    if (!this.allowWrites) {
      this.log("warn", `set '${name}' skipped: writes disabled by plugin config`);
      return false;
    }
    if (!this.healthy || this.address === null) {
      this.log("warn", `set '${name}' skipped: pypilot not heard on NMEA 2000`);
      return false;
    }
    try {
      if (!this.setPrimary(name, value)) {
        this.writes.push({ kind: "write", name, command: `${name}=${JSON.stringify(value)}` });
      }
      return true;
    } catch (e: any) {
      this.log("warn", `set '${name}' failed: ${e?.message || e}`);
      return false;
    }
  }

  // The primary controls, sent as standard PGNs. False if this write isn't one.
  private setPrimary(name: string, value: unknown): boolean {
    const mode = this.lastValues["ap.mode"];
    const enabled = this.lastValues["ap.enabled"] === true;
    if (name === "ap.enabled" && typeof value === "boolean") {
      if (!value) {
        if (this.bank !== null) this.press(CH_STANDBY);
        else this.command127237(STEERING_MAIN, null);
      } else if (this.bank !== null && typeof mode === "string" && mode in CH_MODES) {
        this.press(CH_MODES[mode]);  // engage, in the current mode
      } else {
        // pypilot keeps its mode, except nav, which needs track control
        this.command127237(mode === "nav" ? STEERING_TRACK : STEERING_HEADING, null);
      }
      return true;
    }
    if (name === "ap.mode" && typeof value === "string" && enabled &&
        this.bank !== null && value in CH_MODES) {
      this.press(CH_MODES[value]);  // engaged: changes mode, keeping the course
      return true;
    }
    if (name === "ap.heading_command" && typeof value === "number" && !isWind(mode)) {
      // pypilot refuses headings in wind modes over 127237: they're wind angles
      this.command127237(null, value);
      return true;
    }
    if (name === "ap.tack.direction" && this.bank !== null && typeof value === "string") {
      this.pendingTackDirection = value;  // sent with the tack's begin
      return true;
    }
    if (name === "ap.tack.state" && value === "begin" && this.bank !== null) {
      const dir = this.pendingTackDirection;
      this.pendingTackDirection = null;
      this.press(dir === "port" ? CH_TACK_PORT : dir === "starboard" ? CH_TACK_STARBOARD : CH_TACK);
      return true;
    }
    if (name === "servo.command" && typeof value === "number" && this.bank !== null && !enabled) {
      // manual steering: jog pulses that end on pypilot's own timer
      if (value !== 0) this.press(value < 0 ? CH_JOG_STARBOARD : CH_JOG_PORT);
      return true;
    }
    return false;
  }

  adjustHeading(degrees: number): boolean {
    if (this.bank === null || !this.healthy || !this.allowWrites || !Number.isInteger(degrees)) {
      return false;
    }
    // +1 turns 1 degree to starboard, which lowers a wind angle
    const turn = isWind(this.lastValues["ap.mode"]) ? -degrees : degrees;
    const tens = Math.trunc(turn / 10);
    const ones = turn - tens * 10;
    if (Math.abs(tens) + Math.abs(ones) > MAX_PRESSES) return false;
    // relative presses add up in pypilot however quickly they arrive
    for (let i = 0; i < Math.abs(tens); i++) this.press(tens > 0 ? CH_PLUS10 : CH_MINUS10);
    for (let i = 0; i < Math.abs(ones); i++) this.press(ones > 0 ? CH_PLUS1 : CH_MINUS1);
    return true;
  }

  // ---- N2K out -------------------------------------------------------------

  private send(pgn: number, destination: number, data: number[]): void {
    // the server puts in its own source address and splits fast packets
    const msg = `${new Date().toISOString()},3,${pgn},0,${destination},${data.length},${hex(data)}`;
    this.opts.app.emit("nmea2000out", msg);
  }

  // 126208 Command group function writing fields of pgn: [index, value bytes]
  private command(pgn: number, params: Array<[number, number[]]>): void {
    if (this.address === null) throw new Error("pypilot not found on NMEA 2000");
    const data = [0x01, pgn & 0xff, (pgn >> 8) & 0xff, (pgn >> 16) & 0xff, 0xf8, params.length];
    for (const [index, value] of params) data.push(index, ...value);
    this.send(126208, this.address, data);
  }

  private command127237(steering: number | null, degrees: number | null): void {
    const params: Array<[number, number[]]> = [];
    if (steering !== null) params.push([5, [steering]]);
    if (degrees !== null) {
      const raw = Math.round(((((degrees % 360) + 360) % 360) * Math.PI / 180) / 0.0001);
      params.push([11, [raw & 0xff, (raw >> 8) & 0xff]]);
    }
    this.command(127237, params);
  }

  // 127502: one channel ON then OFF, as a momentary key
  private press(channel: number): void {
    if (this.bank === null) throw new Error("pypilot's n2k.switch.bank is not set");
    for (const state of [1, 0]) {
      const bits = new Array(7).fill(0xff);  // 'no change' on every other channel
      const i = channel - 1;
      bits[i >> 2] = (bits[i >> 2] & ~(3 << ((i & 3) * 2)) & 0xff) | (state << ((i & 3) * 2));
      this.send(127502, 255, [this.bank, ...bits]);
    }
  }

  private sendText(request: Request): void {
    const tag = `sk${this.tagCount++ % 1000}`;
    const text = Buffer.from(`PP#${tag}:${request.command}`, "ascii");
    const now = Date.now();
    this.current = {
      ...request, tag, sent: now,
      timeout: now + (request.kind === "write" ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS),
    };
    this.lastSent = now;
    this.command(126998, [[1, [text.length + 2, 1, ...text]]]);  // LAU string
  }

  // ---- scheduling ------------------------------------------------------------

  private tick(): void {
    const now = Date.now();
    if (this.online && now - this.lastHeard > OFFLINE_MS) {
      this.online = false;
      this.current = null;
      if (typeof this.opts.address !== "number") this.address = null;  // may come back elsewhere
      this.log("warn", "pypilot not heard on NMEA 2000");
      this.emit("disconnect", "pypilot not heard on NMEA 2000");
    }
    if (!this.online) return;
    if (this.current) {
      if (now < this.current.timeout) return;
      this.log("debug", `no answer to PP:${this.current.command}`);
      if (this.current.kind === "chunk") this.catalogLoading = false;  // try again later
      this.current = null;
    }
    const gap = 1000 / (this.opts.maxRequestsPerSecond || 10);
    if (now - this.lastSent < gap) return;
    const next = this.nextRequest(now);
    if (next) {
      try {
        this.sendText(next);
      } catch (e: any) {
        this.log("warn", e?.message || String(e));
      }
    }
  }

  private nextRequest(now: number): Request | null {
    if (this.writes.length) return this.writes.shift() as Request;
    if (now >= this.settingsDue) {
      this.settingsDue = now + SETTINGS_PERIOD_S * 1000;
      return { kind: "settings", command: "n2k.switch.bank" };
    }
    // the watch due longest ago, skipping values pypilot's broadcasts carry
    let best: string | null = null;
    let bestDue = Infinity;
    for (const [name, w] of this.watches) {
      const fed = this.fedAt[name];
      if (fed && now - fed < w.period * 1000 + 1000) {
        w.due = fed + w.period * 1000;
        continue;
      }
      if (w.due <= now && w.due < bestDue) {
        best = name;
        bestDue = w.due;
      }
    }
    if (best !== null) {
      const w = this.watches.get(best)!;
      w.due = now + w.period * 1000;
      return { kind: "read", name: best, command: best };
    }
    if (this.catalogLoading) {
      return { kind: "chunk", command: `values@${this.catalogText.length}` };
    }
    return null;
  }

  // ---- N2K in --------------------------------------------------------------

  private isPyPilot(src: number): boolean {
    const sources = this.opts.app.getPath?.("/sources") || {};
    return Object.values(sources).some((provider: any) => {
      const n2k = provider && typeof provider === "object" && provider[String(src)]?.n2k;
      return !!n2k && [n2k.modelId, n2k.manufacturerInformation, n2k.productName].some(
        (s: unknown) => typeof s === "string" && /pypilot/i.test(s));
    });
  }

  private receive(evt: any): void {
    if (![127237, 127501, 126998].includes(evt.pgn)) return;
    if (this.address === null) {
      if (!this.isPyPilot(evt.src)) return;
      this.address = evt.src;
      this.log("info", `pypilot found at N2K address ${this.address}`);
    }
    if (evt.src !== this.address) return;
    const now = Date.now();
    this.lastHeard = now;
    if (!this.online) {
      this.online = true;
      this.settingsDue = 0;
      this.emit("connect");
      this.loadCatalog();
    }
    if (evt.pgn === 127501) {
      if (this.bank === null || field(evt, "instance", "Instance") !== this.bank) return;
      const on = (ch: number) => field(evt, `indicator${ch}`, `Indicator${ch}`) === "On";
      const enabled = !on(CH_STANDBY);
      this.feed("ap.enabled", enabled, now);
      for (const mode in CH_MODES) {
        if (enabled && on(CH_MODES[mode])) this.feed("ap.mode", mode, now);  // only shown engaged
      }
    } else if (evt.pgn === 127237) {
      let steering = field(evt, "steeringMode", "Steering Mode");
      if (typeof steering === "string") steering = STEERING_NAMES[steering];
      if (typeof steering === "number") this.feed("ap.enabled", steering !== STEERING_MAIN, now);
      // in wind modes this is the equivalent compass heading, not the wind angle
      const hts = field(evt, "headingToSteerCourse", "Heading-To-Steer (Course)");
      const mode = this.lastValues["ap.mode"];
      if (typeof hts === "number" && typeof mode === "string" && !isWind(mode)) {
        this.feed("ap.heading_command", Math.round(hts * 180 / Math.PI * 100) / 100, now);
      }
    } else if (evt.pgn === 126998) {
      const d2 = field(evt, "installationDescription2", "Installation Description #2");
      if (typeof d2 === "string") this.textResult(d2, now);
    }
  }

  private feed(name: string, value: unknown, now: number): void {
    this.fedAt[name] = now;
    this.value(name, value);
  }

  private value(name: string, value: unknown): void {
    const json = JSON.stringify(value);
    if (this.lastJson[name] === json) return;
    if (name === "ap.mode" && isWind(value) && !isWind(this.lastValues["ap.mode"])) {
      // 127237 carries a compass heading, not the new mode's wind angle:
      // read the heading command now rather than trust the last broadcast
      delete this.fedAt["ap.heading_command"];
      const w = this.watches.get("ap.heading_command");
      if (w) w.due = 0;
    }
    this.lastJson[name] = json;
    this.lastValues[name] = value;
    this.emit("value", name, value);
  }

  private textResult(d2: string, now: number): void {
    const request = this.current;
    if (!request || !d2.startsWith(`#${request.tag} `)) return;
    this.current = null;
    this.emit("pong", now - request.sent);
    const result = d2.slice(request.tag.length + 2);
    if (result.startsWith("ERR")) {
      this.log("debug", `PP:${request.command}: ${result}`);
      if (request.kind === "chunk") this.catalogLoading = false;
      return;
    }
    const body = result.startsWith("OK ") ? result.slice(3) : result;
    const eq = body.indexOf("=");
    if (eq < 0) return;
    const header = body.slice(0, eq);
    const text = body.slice(eq + 1);
    if (request.kind === "chunk") {
      this.catalogChunk(header, text);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;  // truncated: a long value needs reading in chunks
    }
    if (request.kind === "settings") {
      this.bank = typeof value === "number" && value >= 0 ? Math.round(value) : null;
      return;
    }
    this.value(header, value);
  }

  // ---- catalog -------------------------------------------------------------

  private loadCatalog(): void {
    if (!Object.keys(this.catalog).length && this.opts.catalogCachePath) {
      try {
        const cached = JSON.parse(fs.readFileSync(this.opts.catalogCachePath, "utf8"));
        if (cached && typeof cached === "object") {
          this.catalog = cached;
          this.log("info", `catalog from cache: ${Object.keys(cached).length} vars`);
          this.emit("catalog", this.catalog, { isDelta: false, newKeys: Object.keys(cached) });
        }
      } catch { /* no cache yet */ }
    }
    this.catalogText = "";
    this.catalogTotal = -1;
    this.catalogLoading = true;
  }

  private catalogChunk(header: string, chunk: string): void {
    const m = /^values@(\d+)\/(\d+)$/.exec(header);
    if (!m) return;
    const offset = Number(m[1]);
    const total = Number(m[2]);
    if (offset !== this.catalogText.length || (this.catalogTotal >= 0 && total !== this.catalogTotal)) {
      this.catalogText = "";  // changed while reading: start again
      this.catalogTotal = -1;
      return;
    }
    this.catalogTotal = total;
    this.catalogText += chunk;
    if (this.catalogText.length < total) return;
    this.catalogLoading = false;
    let fresh: PypilotCatalog;
    try {
      fresh = JSON.parse(this.catalogText);
    } catch (e: any) {
      this.log("warn", `catalog parse failed: ${e?.message || e}`);
      return;
    }
    const hadKeys = Object.keys(this.catalog).length > 0;
    const newKeys = Object.keys(fresh).filter((k) => !(k in this.catalog));
    const changed = JSON.stringify(fresh) !== JSON.stringify(this.catalog);
    this.catalog = fresh;
    this.log("info", `catalog read: ${Object.keys(fresh).length} vars`);
    if (this.opts.catalogCachePath) {
      try { fs.writeFileSync(this.opts.catalogCachePath, JSON.stringify(fresh)); } catch { /* best effort */ }
    }
    if (!hadKeys) this.emit("catalog", this.catalog, { isDelta: false, newKeys });
    else if (changed) this.emit("catalog", this.catalog, { isDelta: true, newKeys });
  }
}
