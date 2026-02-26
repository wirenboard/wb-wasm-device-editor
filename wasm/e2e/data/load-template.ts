/**
 * Loads a real device template JSON from wb-mqtt-serial/templates/
 * and converts it to the formats expected by the frontend stores:
 *
 *   - DeviceTypeDescriptionGroup[] for configGetDeviceTypes
 *   - JSON Schema wrapper for configGetSchema (consumed by loadJsonSchema)
 *   - Default parameter values for deviceLoadConfig
 *
 * The C++ confed schema generator converts the raw template's
 * parameters dict {"param_name": {...}} into an array [{id: "param_name", ...}].
 * We replicate that conversion here.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

/** Raw template format as stored in config-*.json files */
interface RawTemplate {
  title: string;
  device_type: string;
  group: string;
  deprecated?: boolean;
  hw?: Array<{ signature: string; fw?: string }>;
  device: {
    name: string;
    id: string;
    groups?: Array<{ title: string; id: string; description?: string; order?: number }>;
    parameters?: Record<string, RawParameter>;
    channels?: Array<Record<string, unknown>>;
    translations?: Record<string, Record<string, string>>;
    [key: string]: unknown;
  };
}

interface RawParameter {
  title: string;
  address: string | number;
  reg_type: string;
  format?: string;
  min?: number;
  max?: number;
  default?: number;
  enum?: number[];
  enum_titles?: string[];
  group?: string;
  order?: number;
  description?: string;
  condition?: string;
  fw?: string;
  [key: string]: unknown;
}

/** Parameter in array form with id field (what the frontend expects) */
export interface TemplateParameter {
  id: string;
  title: string;
  address: string | number;
  reg_type: string;
  format?: string;
  min?: number;
  max?: number;
  default?: number;
  enum?: number[];
  enum_titles?: string[];
  group?: string;
  order?: number;
  description?: string;
  condition?: string;
  fw?: string;
  [key: string]: unknown;
}

export interface DeviceTemplate {
  title: string;
  device_type: string;
  group: string;
  deprecated: boolean;
  hw: Array<{ signature: string; fw?: string }>;
  device: {
    name: string;
    id: string;
    groups: Array<{ title: string; id: string; description?: string; order?: number }>;
    parameters: TemplateParameter[];
    channels: Array<Record<string, unknown>>;
    translations?: Record<string, Record<string, string>>;
    [key: string]: unknown;
  };
}

const TEMPLATES_DIR = resolve(__dirname, '../../../submodule/wb-mqtt-serial/templates');

/**
 * Load and parse a device template from wb-mqtt-serial/templates/.
 * Converts parameters from dict to array with id fields.
 */
export function loadTemplate(filename: string): DeviceTemplate {
  const raw: RawTemplate = JSON.parse(
    readFileSync(resolve(TEMPLATES_DIR, filename), 'utf-8'),
  );

  // Convert parameters dict to array with id fields
  const parameters: TemplateParameter[] = [];
  if (raw.device.parameters) {
    for (const [id, param] of Object.entries(raw.device.parameters)) {
      parameters.push({ id, ...param });
    }
  }

  return {
    title: raw.title,
    device_type: raw.device_type,
    group: raw.group,
    deprecated: !!raw.deprecated,
    hw: raw.hw ?? [],
    device: {
      ...raw.device,
      groups: raw.device.groups ?? [],
      parameters,
      channels: raw.device.channels ?? [],
    },
  };
}

/**
 * Build a configGetDeviceTypes response entry for one template.
 * Translates the template title using the embedded translations.
 */
export function buildDeviceTypeEntry(tmpl: DeviceTemplate, lang = 'en') {
  const translations = tmpl.device.translations?.[lang] ?? {};
  const name = translations[tmpl.title] ?? tmpl.device.name;

  return {
    name,
    deprecated: tmpl.deprecated,
    type: tmpl.device_type,
    protocol: 'modbus',
    'mqtt-id': tmpl.device.id,
    'with-subdevices': false,
    hw: tmpl.hw,
  };
}

/**
 * Build a configGetSchema response for a template.
 * Returns the schema object that the C++ confed generator would produce,
 * in the minimal form that loadJsonSchema + DeviceSettingsObjectStore need.
 */
export function buildSchema(tmpl: DeviceTemplate) {
  return {
    type: 'object',
    properties: {
      device_type: {
        type: 'string',
        enum: [tmpl.device_type],
        default: tmpl.device_type,
        options: { hidden: true },
      },
      slave_id: {
        type: 'string',
        title: 'Slave ID',
        description: 'Modbus address',
      },
    },
    required: ['device_type', 'slave_id'],
    device: {
      ...tmpl.device,
      // Ensure translations are at the device level for the schema translator
      translations: tmpl.device.translations,
    },
    translations: tmpl.device.translations,
    definitions: {},
  };
}

/**
 * Build a deviceLoadConfig result with default values for all parameters.
 * This simulates reading registers from a real device that has factory defaults.
 */
export function buildDefaultConfig(tmpl: DeviceTemplate): Record<string, number | string> {
  const parameters: Record<string, number | string> = {};
  for (const param of tmpl.device.parameters) {
    if (param.default !== undefined) {
      parameters[param.id] = param.default;
    }
  }
  return parameters;
}

/**
 * Build a deviceLoadConfig result with specific overrides.
 * Starts from defaults, then applies overrides.
 */
export function buildConfig(
  tmpl: DeviceTemplate,
  overrides: Record<string, number | string> = {},
): Record<string, number | string> {
  return { ...buildDefaultConfig(tmpl), ...overrides };
}
