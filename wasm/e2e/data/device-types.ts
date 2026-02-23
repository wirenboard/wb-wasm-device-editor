/**
 * Canned configGetDeviceTypes response.
 * Format matches DeviceTypeDescriptionGroup[] expected by DeviceTypesStore.setDeviceTypeGroups().
 */
export const deviceTypeGroups = [
  {
    name: 'WB Electricity Meters',
    types: [
      {
        name: 'WB-MAP3ET',
        type: 'WB-MAP3ET',
        deprecated: false,
        protocol: 'modbus',
        'mqtt-id': 'wb-map3et',
        hw: [
          { signature: 'WB-MAP3ET', fw: '2.5.0' },
        ],
      },
    ],
  },
];
