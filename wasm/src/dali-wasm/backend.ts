/**
 * The channel between the DALI page and wb-mqtt-dali running under Pyodide.
 *
 * Everything the page needs is MQTT pub/sub, because that is all the daemon
 * speaks. Keeping the surface this narrow is what lets the page run unmodified:
 * homeui talks to a real broker over websockets, we talk to a loopback broker in
 * a worker, and neither side can tell.
 */

export type MessageHandler = (topic: string, payload: string, retained: boolean) => void;

export interface DaliBackend {
  /** Resolves once wb-mqtt-dali has booted and its RPC endpoints answer. */
  readonly ready: Promise<void>;

  /** Client id, used to build per-client RPC reply topics. */
  readonly clientId: string;

  publish(topic: string, payload: string, retain?: boolean, qos?: number): void;

  /** Subscribe to a topic filter. `+` matches one level, `#` the rest. */
  subscribe(pattern: string, handler: MessageHandler): void;

  /** Drop every handler for a filter, matching homeui's mqttClient semantics. */
  unsubscribe(pattern: string): void;

  dispose(): void;
}

/** What the simulated DALI installation should look like when the page opens. */
export interface SimulationScenario {
  /** MQTT device ids of the WB-DALI modules on the emulated Modbus network. */
  gateways: string[];
  /** Control gear per bus, keyed by bus number 1..3. */
  gear: Record<number, SimulatedGear[]>;
  /** Seconds of simulated bus time charged per DALI frame; 0 keeps the UI instant. */
  frameDelaySeconds?: number;
}

export interface SimulatedGear {
  /** Short address 0..63, or null for a factory-fresh unit awaiting commissioning. */
  shortAddress: number | null;
  /** 24-bit random address, unique per unit. */
  randomAddress: number;
  /** DALI device types the unit reports, e.g. [6] for an LED driver, [8] for colour. */
  deviceTypes?: number[];
  groups?: number[];
}
