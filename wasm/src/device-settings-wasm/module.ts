import { makeObservable, observable } from 'mobx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Device, LoadingProgress } from './types';
import { WasmFwUpdateProxy } from './fw-update-proxy';

export const useModule = (isOffline: boolean = false) => {
  const [moduleState, setModuleState] = useState<{
    scanMessage: string;
    scanCount: number;
    bootScanMessage: string;
    bootScanCount: number;
    bootScanType: string;
    portScan: PortScan;
    bootScan: any;
    moduleInitialized: boolean;
  }>({
    scanMessage: '',
    scanCount: 0,
    bootScanMessage: '',
    bootScanCount: 0,
    bootScanType: '',
    portScan: null,
    bootScan: null,
    moduleInitialized: false,
  });

  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>({ loaded: 0, total: 0, percent: 0 });

  useEffect(() => {
    return Module.onLoadingProgress((progress) => {
      setLoadingProgress({ ...progress });
    });
  }, []);

  useEffect(() => {
    const portScan = new PortScan((status) =>
      setModuleState((prevState) => ({
        ...prevState,
        scanMessage: status.options ? `(${status.options})` : '',
        scanCount: status.count,
      })),
    );

    const bootScan = new BootScan((status) =>
      setModuleState((prevState) => ({
        ...prevState,
        bootScanMessage: status.options ? `(${status.options}${status.slaveId ? ' #' + status.slaveId : ''})` : '',
        bootScanCount: status.count,
        bootScanType: status.type || '',
      })),
    );

    makeObservable(portScan, {
      progress: observable,
    });

    makeObservable(bootScan, {
      progress: observable,
    });

    (async () => {
      await Module.isReady;
      setModuleState((prevState) => ({ ...prevState, moduleInitialized: true, portScan, bootScan }));
    })();
  }, []);

  const initializeModule = useCallback(async () => {
    if (moduleState.moduleInitialized) return;
    await (async () => {
      await Module.isReady;
      setModuleState((prevState) => ({ ...prevState, moduleInitialized: true }));
    })();
  }, [moduleState.moduleInitialized]);

  const selectPort = useCallback(async () => {
    await initializeModule();
    await Module.serial.forceSelect();
  }, [initializeModule]);

  const getPortInfo = useCallback(async (): Promise<{ name: string | null; matchingCount: number }> => {
    await initializeModule();
    return Module.serial.getPortInfo();
  }, [initializeModule]);

  const setExtendedTimeout = useCallback((enabled: boolean) => {
    Module.serial.setExtendedTimeout(enabled);
  }, []);

  const scan = useCallback(async (): Promise<Device[]> => {
    await initializeModule();
    return moduleState.portScan.exec().then(({ devices }) => devices);
  }, [initializeModule, moduleState.portScan]);

  const bootScan = useCallback(async (): Promise<any[]> => {
    await initializeModule();
    return moduleState.bootScan.exec().then(({ devices }) => devices);
  }, [initializeModule, moduleState.bootScan]);

  const stopScan = useCallback(() => {
    moduleState.portScan?.stop();
  }, [moduleState.portScan]);

  const stopBootScan = useCallback(() => {
    moduleState.bootScan?.stop();
  }, [moduleState.bootScan]);

  const findDevice = useCallback(async (cfg: any) => {
    await initializeModule();
    return moduleState.bootScan.findDevice(cfg);
  }, [initializeModule, moduleState.bootScan]);

  const loadConfig = useCallback(
    async (cfg) => {
      await initializeModule();
      return Module.request('deviceLoadConfig', cfg);
    },
    [initializeModule],
  );

  const configGetDeviceTypes = useCallback(
    async (lang: string) => {
      await initializeModule();
      return Module.request('configGetDeviceTypes', { lang }).then((res) => res.result);
    },
    [initializeModule],
  );

  const configGetSchema = useCallback(
    async (deviceType: string) => {
      await initializeModule();
      return Module.request('configGetSchema', { type: deviceType }).then((res) => res.result);
    },
    [initializeModule],
  );

  const save = useCallback(
    async (data: any) => {
      await initializeModule();
      return Module.request('deviceSet', data);
    },
    [initializeModule],
  );

  const deviceLoad = useCallback(
    async (data: any) => {
      await initializeModule();
      return Module.request('deviceLoad', data);
    },
    [initializeModule],
  );

  const portSetup = useCallback(
    async (data: any) => {
      await initializeModule();
      return Module.request('portSetup', data);
    },
    [initializeModule],
  );

  const isOfflineRef = useRef(isOffline);
  isOfflineRef.current = isOffline;
  const fwUpdateProxy = useMemo(() => new WasmFwUpdateProxy(() => isOfflineRef.current), []);

  const subscribeFwUpdateState = useCallback((callback: (state: unknown) => void) => {
    return Module.subscribeFwUpdateState(callback);
  }, []);

  return {
    moduleInitialized: moduleState.moduleInitialized,
    progress: moduleState.portScan?.progress,
    loadingProgress,
    initializeModule,
    selectPort,
    getPortInfo,
    setExtendedTimeout,
    scan,
    bootScan,
    stopScan,
    stopBootScan,
    findDevice,
    scanMessage: moduleState.scanMessage,
    scanCount: moduleState.scanCount,
    bootScanMessage: moduleState.bootScanMessage,
    bootScanCount: moduleState.bootScanCount,
    bootScanType: moduleState.bootScanType,
    bootScanProgress: moduleState.bootScan?.progress,
    loadConfig,
    configGetDeviceTypes,
    configGetSchema,
    save,
    deviceLoad,
    portSetup,
    fwUpdateProxy,
    subscribeFwUpdateState,
  };
};
