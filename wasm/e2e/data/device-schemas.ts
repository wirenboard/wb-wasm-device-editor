/**
 * Device schemas built from real wb-mqtt-serial templates.
 * Returns the JSON schema wrapper format expected by loadJsonSchema + DeviceSettingsObjectStore.
 */
import { buildSchema } from './load-template';
import { map3et } from './device-types';

export const deviceSchemas: Record<string, object> = {
  [map3et.device_type]: buildSchema(map3et),
};
