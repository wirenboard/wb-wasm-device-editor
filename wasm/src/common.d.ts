declare module '*.svg' {
  import { FC, SVGProps } from 'react';

  interface CustomSVGProps extends SVGProps<SVGSVGElement> {
    title?: string;
    className?: string;
  }

  export const ReactComponent: FC<CustomSVGProps>;
  const src: FC<CustomSVGProps>;
  export default src;
}

declare module '*.css' {}

interface ImportMetaEnv {
  readonly MODE: string;
  readonly BASE_URL: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly SSR: boolean;
  [key: string]: any;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
declare const __APP_OFFLINE_BUILD__: boolean;
declare const __APP_NAME__: string;
declare const __APP_SHORT_NAME__: string;
declare const __LOGO__: string;
declare const __LOGO_COMPACT__: string;
declare const __HIDE_COMPACT_MENU__: boolean;

declare class PortScan {
  constructor(callback: (options: any) => void);
  exec(): Promise<{ devices: any[] }>;
  stop(): void;
  progress: number;
}

declare class BootScan {
  constructor(callback: (options: any) => void);
  exec(): Promise<{ devices: any[] }>;
  stop(): void;
  findDevice(cfg: any): Promise<any>;
  progress: number;
}

declare const Module: {
  request: (method: string, params: any) => Promise<any>;
  serial: {
    select: (auto: boolean) => Promise<any>;
    forceSelect: () => Promise<any>;
    getPortInfo: () => Promise<{ name: string | null; matchingCount: number }>;
    setExtendedTimeout: (enabled: boolean) => void;
  };
  isReady: Promise<void>;
  loadingProgress: import('./device-settings-wasm/types').LoadingProgress | null;
  onLoadingProgress: (callback: (progress: import('./device-settings-wasm/types').LoadingProgress) => void) => () => void;
  subscribeFwUpdateState: (callback: (state: unknown) => void) => () => void;
};
