export interface TemplateChannel {
  name: string;
  type?: string;
  readonly?: boolean;
  units?: string;
  min?: number;
  max?: number;
  scale?: number;
  enum?: (number | string)[];
  enum_titles?: string[];
  address?: number;
  reg_type?: string;
  enabled?: boolean;
  condition?: string;
  fw?: string;
}

export interface RuntimeViewProps {
  deviceCfg: {
    slave_id: number;
    device_type: string;
    baud_rate: number;
    parity: string;
    data_bits: number;
    stop_bits: number;
  };
  deviceLoad: (data: any) => Promise<any>;
  save: (data: any) => Promise<any>;
  configGetSchema: (deviceType: string) => Promise<any>;
}
