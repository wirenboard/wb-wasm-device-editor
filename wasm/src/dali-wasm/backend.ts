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

/**
 * What the simulated DALI installation looks like.
 *
 * Mirrors `wbdali_browser.scenario`, which is the authority: it is what parses
 * this, and what writes it back with the short addresses a scan assigned.
 */
export interface SimulationScenario {
  gateways: SimulatedGateway[];
  /** Seconds of simulated bus time charged per DALI frame; 0 keeps the UI instant. */
  frameDelaySeconds?: number;
}

export interface SimulatedGateway {
  /** MQTT device id of the WB-DALI module. */
  id: string;
  /** Its Modbus address. */
  slaveId?: number;
  /** What is wired to each bus, keyed by bus number "1".."3". */
  buses: Record<string, SimulatedBus>;
}

export interface SimulatedBus {
  /** Luminaires: control gear, on 16-bit frames. */
  gear?: SimulatedGear[];
  /** Wall switches and sensors: DALI-2 control devices, on 24-bit frames. */
  devices?: SimulatedDevice[];
}

export interface SimulatedGear {
  /** Short address 0..63, or null for a factory-fresh unit awaiting commissioning. */
  shortAddress: number | null;
  /** 24-bit random address, unique per unit. */
  randomAddress: number;
  /** DALI device types the unit reports, e.g. [6] for an LED driver, [8] for colour. */
  deviceTypes?: number[];
  /** Colour temperature in mireds, for a DT8 unit. */
  colourTemperature?: number;
  groups?: number[];
}

export interface SimulatedDevice {
  shortAddress: number | null;
  randomAddress: number;
}
