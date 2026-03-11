import type { LoadingProgress } from './device-settings-wasm/types';

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
  loadingProgress: LoadingProgress | null;
  onLoadingProgress: (callback: (progress: LoadingProgress) => void) => () => void;
};
