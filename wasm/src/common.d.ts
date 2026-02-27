declare class PortScan {
  constructor(callback: (options: any) => void);
  exec(): Promise<{ devices: any[] }>;
  progress: number;
}

interface LoadingProgress {
  loaded: number;
  total: number;
  percent: number;
}

declare const Module: {
  request: (method: string, params: any) => Promise<any>;
  serial: {
    select: (auto: boolean) => Promise<any>;
  };
  isReady: Promise<void>;
  loadingProgress: LoadingProgress | null;
  onLoadingProgress: (callback: (progress: LoadingProgress) => void) => () => void;
};
