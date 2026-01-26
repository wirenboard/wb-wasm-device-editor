declare class PortScan {
  constructor(callback: (options: any) => void);
  exec(): Promise<{ devices: any[] }>;
  progress: number;
}

declare const Module: {
  request: (method: string, params: any) => Promise<any>;
  serial: {
    select: (auto: boolean) => Promise<any>;
  };
  isReady: Promise<void>;
};
