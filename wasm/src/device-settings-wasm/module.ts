import { makeObservable, observable } from 'mobx';
import { useCallback, useEffect, useState } from 'react';
import type { Device } from './types';

export const useModule = () => {
  const [moduleState, setModuleState] = useState<{
    scanMessage: string;
    portScan: PortScan;
    moduleInitialized: boolean;
  }>({
    scanMessage: '',
    portScan: null,
    moduleInitialized: false,
  });

  useEffect(() => {
    const portScan = new PortScan((options) =>
      setModuleState((prevState) => ({ ...prevState, scanMessage: options.options })),
    );

    makeObservable(portScan, {
      progress: observable,
    });

    (async () => {
      await Module.isReady;
      setModuleState((prevState) => ({ ...prevState, moduleInitialized: true, portScan }));
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

  const getPortInfo = useCallback(async (): Promise<{ name: string | null; hexId: string | null; matchingCount: number }> => {
    await initializeModule();
    return Module.serial.getPortInfo();
  }, [initializeModule]);

  const scan = useCallback(async (): Promise<Device[]> => {
    await initializeModule();
    return moduleState.portScan.exec().then(({ devices }) => devices);
  }, [initializeModule, moduleState.portScan]);

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

  return {
    moduleInitialized: moduleState.moduleInitialized,
    progress: moduleState.portScan?.progress,
    initializeModule,
    selectPort,
    getPortInfo,
    scan,
    scanMessage: moduleState.scanMessage,
    loadConfig,
    configGetDeviceTypes,
    configGetSchema,
    save,
    deviceLoad,
    portSetup,
  };
};
