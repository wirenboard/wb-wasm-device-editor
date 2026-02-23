/**
 * Canned configGetSchema response for WB-MAP3ET.
 * Minimal valid schema compatible with DeviceTabStore / loadJsonSchema parsing.
 */
export const deviceSchemas: Record<string, object> = {
  'WB-MAP3ET': {
    device: {
      name: 'WB-MAP3ET',
      device_type: 'WB-MAP3ET',
      parameters: [
        {
          id: 'baud_rate',
          title: 'Baud rate',
          address: 110,
          reg_type: 'holding',
          type: 'number',
          default: 9600,
          enum: [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200],
          order: 1,
          group: 'general',
        },
      ],
      groups: [
        {
          title: 'General',
          id: 'general',
        },
      ],
      channels: [],
    },
  },
};
