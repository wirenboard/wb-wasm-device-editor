/**
 * The WB-DALI gateways the Modbus scan found.
 *
 * The DALI configurator only means something when there is a gateway to
 * configure, so the entry point into it is gated on this, and what the scan
 * found is also what the DALI runtime is pointed at: the module's Modbus
 * address and the line settings it answered on, rather than a guess.
 */

import type { InstallationScenario } from './backend';

/**
 * Device types that are a DALI gateway.
 *
 * `WB-DALI` is the type both the WB-DALI and WB-MDALI hardware signatures
 * resolve to — the three-channel RS485-to-DALI gateway. The raw signatures are
 * matched too, because a device whose firmware has no template falls back to
 * reporting its signature as the type. This is the same pair wb-mqtt-dali
 * itself looks for when it reads wb-mqtt-serial's config.
 */
export const DALI_DEVICE_TYPES = ['WB-DALI', 'WB-MDALI'];

const STORAGE_KEY = 'wb-dali-gateways';

export interface DaliGateway {
  /** The id the daemon knows the module by, in wb-mqtt-dali's own convention. */
  id: string;
  slaveId: number;
  deviceType: string;
  /** The line settings the module answered the scan on. */
  serial: {
    baud_rate: number;
    data_bits: number;
    parity: string;
    stop_bits: number;
  };
}

export function isDaliGateway(deviceType: string | undefined): boolean {
  return !!deviceType && DALI_DEVICE_TYPES.includes(deviceType);
}

/** Pick the DALI gateways out of a scan result. */
export function findDaliGateways<T extends { cfg: DaliGateway['serial'] & { slave_id: number } }>(
  devices: T[],
  deviceTypeOf: (device: T) => string
): DaliGateway[] {
  return devices
    .filter((device) => isDaliGateway(deviceTypeOf(device)))
    .map((device) => ({
      // wb-mqtt-dali names a gateway `wb-dali_<slave id>` when nothing else
      // supplies an id, which is exactly our situation: there is no
      // wb-mqtt-serial here to have published one.
      id: `wb-dali_${device.cfg.slave_id}`,
      slaveId: device.cfg.slave_id,
      deviceType: deviceTypeOf(device),
      serial: {
        baud_rate: device.cfg.baud_rate,
        data_bits: device.cfg.data_bits,
        parity: device.cfg.parity,
        stop_bits: device.cfg.stop_bits,
      },
    }));
}

/**
 * Describe the found gateways to the DALI runtime.
 *
 * No buses are listed: on real hardware the devices on them are whatever a bus
 * scan finds, and the daemon writes them into its own config afterwards.
 */
export function scenarioForGateways(gateways: DaliGateway[]): InstallationScenario {
  return {
    gateways: gateways.map((gateway) => ({
      id: gateway.id,
      slaveId: gateway.slaveId,
      buses: { 1: {}, 2: {}, 3: {} },
    })),
    serialSettings: gateways[0]?.serial,
  };
}

/**
 * Carry the scan result across to the DALI view.
 *
 * The two views are separate renders with no shared state, and the choice has
 * to survive a reload — the DALI page is where someone spends a while.
 */
export function rememberGateways(gateways: DaliGateway[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(gateways));
  } catch (error) {
    console.warn('DALI: could not record the gateways found', error);
  }
}

export function loadRememberedGateways(): DaliGateway[] {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const gateways = stored ? JSON.parse(stored) : [];
    return Array.isArray(gateways) ? gateways.filter((gateway) => gateway?.id) : [];
  } catch {
    return [];
  }
}
