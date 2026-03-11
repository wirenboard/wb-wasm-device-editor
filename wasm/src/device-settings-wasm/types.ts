export interface Device {
  cfg: {
    baud_rate: number;
    data_bits: number;
    parity: string;
    slave_id: number;
    stop_bits: number;
  };
  device_signature: string;
  fw: {
    version: string;
  };
  fw_signature: string;
  sn: string;
}

export interface LoadingProgress {
  loaded: number;
  total: number;
  percent: number;
}
