/**
 * Device type groups built from real wb-mqtt-serial templates.
 * Format matches DeviceTypeDescriptionGroup[] expected by DeviceTypesStore.setDeviceTypeGroups().
 */
import { loadTemplate, buildDeviceTypeEntry } from './load-template';

export const map3et = loadTemplate('config-map3et.json');

export const deviceTypeGroups = [
  {
    name: 'WB Electricity Meters',
    types: [buildDeviceTypeEntry(map3et)],
  },
];
