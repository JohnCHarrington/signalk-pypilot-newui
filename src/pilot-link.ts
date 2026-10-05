import { EventEmitter } from "events";
import { PypilotCatalog } from "./pypilot-client";

/**
 * A connection to pypilot: PypilotClient (pypilot_web's socket.io) or
 * N2KPypilotClient (NMEA 2000). Both emit the same events:
 *   'connect', 'disconnect' (reason), 'catalog' (catalog, {isDelta, newKeys}),
 *   'value' (name, value), 'pypilot_offline', 'pypilot_online',
 *   'pong' (latencyMs)
 */
export interface PilotLink extends EventEmitter {
  readonly connected: boolean;
  readonly healthy: boolean;
  setAllowWrites(v: boolean): void;
  getCatalog(): PypilotCatalog;
  getValues(): Record<string, unknown>;
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  /** period in seconds; true for every change, false to cancel */
  watch(name: string, period?: true | number | false): void;
  /** write a value; false if it could not be sent */
  set(name: string, value: unknown): boolean;
  /**
   * Change the heading command by whole degrees with the link's own relative
   * commands, which add up however quickly they are sent (NMEA 2000 +1/+10
   * switch presses). False if the link has none for this change: write
   * ap.heading_command instead.
   */
  adjustHeading?(degrees: number): boolean;
}
