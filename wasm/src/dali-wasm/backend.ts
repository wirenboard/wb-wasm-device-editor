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
 * The installation the runtime boots against.
 *
 * Mirrors `wbdali_browser.scenario`, which is the authority: it is what parses
 * this into the wb-mqtt-serial config the daemon discovers its gateways from.
 */
export interface InstallationScenario {
  gateways: ScenarioGateway[];
  /** The line settings the modules answered the Modbus scan on. */
  serialSettings?: {
    baud_rate: number;
    data_bits: number;
    parity: string;
    stop_bits: number;
  };
}

export interface ScenarioGateway {
  /** MQTT device id of the WB-DALI module. */
  id: string;
  /** Its Modbus address. */
  slaveId?: number;
  /** The buses the module has, keyed by bus number "1".."3". */
  buses: Record<string, object>;
}
