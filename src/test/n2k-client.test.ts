import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";

import { N2KPypilotClient } from "../n2k-client";

const PYPILOT = 100;

// The Signal K server as the client sees it: decoded N2K in, actisense out
class FakeServer extends EventEmitter {
  sent: Array<{ pgn: number; dst: number; data: number[] }> = [];
  constructor() {
    super();
    this.on("nmea2000out", (msg: string) => {
      const f = msg.split(",");
      this.sent.push({ pgn: Number(f[2]), dst: Number(f[4]), data: f.slice(6).map((h) => parseInt(h, 16)) });
    });
  }
  getPath(path: string) {
    if (path !== "/sources") return undefined;
    return { can0: { [String(PYPILOT)]: { n2k: { modelId: "pypilot", manufacturerInformation: "PyPilot Autopilot" } } } };
  }
  n2k(pgn: number, fields: Record<string, unknown>, src = PYPILOT) {
    this.emit("N2KAnalyzerOut", { pgn, src, dst: 255, fields });
  }
  // the text of the last PP: command sent
  lastText(): string {
    const cmd = [...this.sent].reverse().find((m) => m.pgn === 126208 && m.data[1] === 0x16);
    if (!cmd) return "";
    const lau = cmd.data.slice(7);  // after 01 pgn(3) f8 count index
    return Buffer.from(lau.slice(2, lau[0])).toString("ascii");
  }
  // pypilot answering the last PP: command
  answer(result: string) {
    const tag = /^PP#(\w+):/.exec(this.lastText())![1];
    this.n2k(126998, { installationDescription1: "", installationDescription2: `#${tag} ${result}` });
  }
  presses(): number[] {
    // channels switched ON in 127502
    const out: number[] = [];
    for (const m of this.sent.filter((s) => s.pgn === 127502)) {
      const bits = m.data.slice(1);
      for (let ch = 1; ch <= 28; ch++) {
        const i = ch - 1;
        if (((bits[i >> 2] >> ((i & 3) * 2)) & 3) === 1) out.push(ch);
      }
    }
    return out;
  }
}

function tick(client: N2KPypilotClient) {
  (client as any).lastSent = 0;  // past the rate limit
  (client as any).tick();
}

function connected(bank: number | null = 5) {
  const server = new FakeServer();
  const client = new N2KPypilotClient({ app: server });
  const values: Record<string, unknown> = {};
  client.on("value", (n: string, v: unknown) => { values[n] = v; });
  let connects = 0;
  client.on("connect", () => connects++);
  client.start();
  (client as any).timer && clearInterval((client as any).timer);  // ticks by hand
  server.n2k(127237, { steeringMode: "Main Steering" });
  assert.equal(connects, 1);
  tick(client);  // reads pypilot's switch bank first
  assert.equal(server.lastText().split(":")[1], "n2k.switch.bank");
  server.answer(`n2k.switch.bank=${bank === null ? -1 : bank}`);
  server.sent = [];
  return { server, client, values };
}

describe("n2k-client / connection", () => {
  it("finds pypilot by its product information and reads its switch bank", () => {
    const { client, values } = connected();
    assert.equal(client.connected, true);
    assert.equal(values["ap.enabled"], false);
    assert.equal((client as any).bank, 5);
    client.stop();
  });

  it("ignores other devices' 127237", () => {
    const server = new FakeServer();
    const client = new N2KPypilotClient({ app: server });
    client.start();
    clearInterval((client as any).timer);
    server.n2k(127237, { steeringMode: "Heading Control" }, 7);
    assert.equal(client.connected, false);
    client.stop();
  });
});

describe("n2k-client / primary controls as standard PGNs", () => {
  it("standby and engage are switch presses with a bank", () => {
    const { server, client } = connected();
    server.n2k(127501, { instance: 5, indicator1: "Off", indicator3: "On" });  // engaged in gps
    assert.equal(client.set("ap.enabled", false), true);
    assert.deepEqual(server.presses(), [1]);
    server.sent = [];
    client.set("ap.enabled", true);
    assert.deepEqual(server.presses(), [3]);  // in its current mode
    client.stop();
  });

  it("without a bank, engage and standby are 127237 commands", () => {
    const { server, client } = connected(null);
    client.set("ap.enabled", false);
    const cmd = server.sent.find((m) => m.pgn === 126208)!;
    assert.equal(cmd.dst, PYPILOT);
    assert.deepEqual(cmd.data.slice(0, 8), [0x01, 0x05, 0xf1, 0x01, 0xf8, 1, 5, 0]);  // steeringMode main
    client.stop();
  });

  it("a heading is 127237, but a wind angle is a PP: write", () => {
    const { server, client } = connected();
    server.n2k(127501, { instance: 5, indicator1: "Off", indicator2: "On" });  // compass
    client.set("ap.heading_command", 90);
    const cmd = server.sent.find((m) => m.pgn === 126208)!;
    const raw = Math.round((Math.PI / 2) / 0.0001);
    assert.deepEqual(cmd.data.slice(5, 9), [1, 11, raw & 0xff, raw >> 8]);
    server.sent = [];
    server.n2k(127501, { instance: 5, indicator1: "Off", indicator5: "On" });  // wind
    client.set("ap.heading_command", -40);
    tick(client);
    assert.equal(server.lastText().split(":")[1], "ap.heading_command=-40");
    client.stop();
  });

  it("adjusts as relative presses, inverted for wind angles", () => {
    const { server, client } = connected();
    server.n2k(127501, { instance: 5, indicator1: "Off", indicator2: "On" });
    assert.equal(client.adjustHeading(-12), true);
    assert.deepEqual(server.presses(), [9, 7, 7]);  // -10, -1, -1
    server.sent = [];
    server.n2k(127501, { instance: 5, indicator1: "Off", indicator5: "On" });
    client.adjustHeading(1);  // raise the wind angle: turn to port
    assert.deepEqual(server.presses(), [7]);
    assert.equal(client.adjustHeading(0.5), false);  // not whole degrees
    client.stop();
  });

  it("tack is one press, in the direction set before it", () => {
    const { server, client } = connected();
    client.set("ap.tack.direction", "starboard");
    client.set("ap.tack.state", "begin");
    assert.deepEqual(server.presses(), [13]);
    client.stop();
  });

  it("other values are PP: writes", () => {
    const { server, client } = connected();
    client.set("ap.pilot.basic.P", 0.004);
    tick(client);
    assert.equal(server.lastText().split(":")[1], "ap.pilot.basic.P=0.004");
    client.stop();
  });

  it("refuses writes when disabled or pypilot isn't heard", () => {
    const { client } = connected();
    client.setAllowWrites(false);
    assert.equal(client.set("ap.enabled", false), false);
    client.stop();
  });
});

describe("n2k-client / values", () => {
  it("reads watched values with PP:, and only reports changes", () => {
    const { server, client, values } = connected();
    let events = 0;
    client.on("value", (n: string) => { if (n === "servo.voltage") events++; });
    client.watch("servo.voltage", 1);
    tick(client);
    assert.equal(server.lastText().split(":")[1], "servo.voltage");
    server.answer("servo.voltage=12.4");
    assert.equal(values["servo.voltage"], 12.4);
    (client as any).watches.get("servo.voltage").due = 0;
    tick(client);
    server.answer("servo.voltage=12.4");
    assert.equal(events, 1);
    client.stop();
  });

  it("doesn't poll values pypilot's broadcasts carry", () => {
    const { server, client } = connected();
    client.watch("ap.enabled", 0.5);
    server.n2k(127501, { instance: 5, indicator1: "On" });
    tick(client);
    assert.notEqual(server.lastText().split(":")[1], "ap.enabled");
    client.stop();
  });

  it("reads the heading command as soon as the mode becomes a wind mode", () => {
    const { server, client } = connected();
    client.watch("ap.heading_command", 0.5);
    server.n2k(127501, { instance: 5, indicator1: "Off", indicator2: "On" });  // compass
    server.n2k(127237, { steeringMode: "Heading Control", headingToSteerCourse: 1 });
    tick(client);
    assert.notEqual(server.lastText().split(":")[1], "ap.heading_command");  // carried by 127237
    server.answer("x=1");
    server.n2k(127501, { instance: 5, indicator1: "Off", indicator5: "On" });  // wind
    tick(client);
    assert.equal(server.lastText().split(":")[1], "ap.heading_command");
    client.stop();
  });

  it("ignores answers to other devices' commands", () => {
    const { server, client, values } = connected();
    client.watch("servo.current", 1);
    tick(client);
    server.n2k(126998, { installationDescription2: "#other servo.current=9" });
    assert.equal(values["servo.current"], undefined);
    client.stop();
  });

  it("reads the catalog in chunks of pypilot's values", () => {
    const { server, client } = connected();
    const catalog = { "ap.mode": { type: "EnumProperty", choices: ["compass", "gps"] },
                      "servo.voltage": { type: "SensorValue", units: "V" } };
    const full = JSON.stringify(catalog);
    let emitted: any = null;
    client.on("catalog", (c: unknown, info: unknown) => { emitted = { c, info }; });
    (client as any).loadCatalog();
    let offset = 0;
    while (offset < full.length) {
      tick(client);
      assert.equal(server.lastText().split(":")[1], `values@${offset}`);
      const chunk = full.slice(offset, offset + 40);
      server.answer(`values@${offset}/${full.length}=${chunk}`);
      offset += chunk.length;
    }
    assert.deepEqual(emitted.c, catalog);
    assert.equal(emitted.info.isDelta, false);
    client.stop();
  });
});
