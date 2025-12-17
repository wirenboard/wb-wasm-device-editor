export interface DeviceSettingsWasmProps {
  scan: () => Promise<Device[]>;
  isReady: Promise<void>;
  selectPort:() => Promise<void>;
  portScan: {
    progress: number;
  }
  loadConfig: (_data: any) => Promise<any>;
  getSchema: (_deviceType: string) => Promise<any>;
  getDeviceTypes: () => Promise<any>;
  save: (_data: any) => Promise<void>;
}

export interface Device {
  cfg: {
    baud_rate: number;
    data_bits: number;
    parity: string;
    slave_id: number;
    stop_bits: number;
  },
  device_signature: string;
  fw: {
    version: string;
  },
  fw_signature: string;
  sn: string;
}
