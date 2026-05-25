import classNames from 'classnames';
import { autorun } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import WarnIcon from '@/assets/icons/warn.svg';
import { Alert } from '@/components/alert';
import { Button } from '@/components/button';
import { Confirm } from '@/components/confirm';
import { Dropdown, type Option } from '@/components/dropdown';
import { Loader } from '@/components/loader';
import { Tabs, useTabs } from '@/components/tabs';
import { PageLayout } from '@/layouts/page';
import { DeviceTabStore, DeviceTypesStore } from '@/stores/device-manager';
import { useAsyncAction } from '@/utils/async-action';
import { setReactLocale } from '~/react-directives/locale';
import { formatBytes } from '../utils/format-bytes';
import { useLocalStorage } from '../utils/useLocalStorage';
import { AddDevice } from './components/add-device';
import { BootloaderDeviceView } from './components/bootloader-device-view';
import { DeviceSettingsView } from './components/device-settings-view';
import { ReleaseSwitcher } from './components/release-switcher';
import { ScanProgress } from './components/scan-progress';
import { useModule } from './module';
import type { Device } from './types';
import './styles.css';

export const DeviceSettingsWasm = observer(() => {
  const { t } = useTranslation();
  const [language, setLanguage] = useState(localStorage.getItem('language') || 'en');
  const [devices, setDevices] = useState<Device[]>([]);
  const [tabstore, setTabstore] = useState(null);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [isConfigLoading, setIsConfigLoading] = useState(false);
  const [isModalOpened, setIsModalOpened] = useState(false);
  const [configDeviceTypesStore, setConfigDeviceTypesStore] = useState(null);
  const [error, setError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [manualDevices, updateManualDevices] = useLocalStorage('devices');
  const allDevices = useMemo(() => [...devices, ...(devices.length ? manualDevices.filter((manual) => {
    return !devices.map((d) => d.cfg.slave_id).includes(manual.cfg.slave_id);
  }) : manualDevices)], [devices, manualDevices]);
  const { activeTab } = useTabs({
    defaultTab: selectedDevice,
    items: allDevices,
  });

  const [isOffline, setIsOffline] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);
  const isTesting = localStorage.getItem('release') === 'testing';
  const release = isTesting ? 'testing' : 'stable';
  const nextRelease = isTesting ? 'stable' : 'testing';
  const [isReleaseConfirmOpen, setIsReleaseConfirmOpen] = useState(false);
  const [isTestingAlertVisible, setIsTestingAlertVisible] = useState(true);
  const applyRelease = () => {
    localStorage.setItem('release', nextRelease);
    window.location.reload();
  };

  useEffect(() => {
    if (isTesting) {
      const original = document.title;
      document.title = `[TESTING] ${original}`;
      return () => { document.title = original; };
    }
  }, [isTesting]);

  useEffect(() => {
    const onUpdate = () => setHasUpdate(true);
    window.addEventListener('sw-update-available', onUpdate);
    return () => window.removeEventListener('sw-update-available', onUpdate);
  }, []);

  // Offline single-file build (file://) sets __WB_FW_OFFLINE__ once its online
  // probe resolves. We mirror it into React state to show a banner when the
  // firmware downloader will fall back to embedded blobs.
  const [isFwOffline, setIsFwOffline] = useState(false);
  useEffect(() => {
    if (!(window as any).__WB_OFFLINE__) return;
    if ((window as any).__WB_FW_OFFLINE__) setIsFwOffline(true);
    const onChange = (e: Event) => setIsFwOffline(!!(e as CustomEvent).detail?.offline);
    window.addEventListener('wb-fw-mode-changed', onChange);
    return () => window.removeEventListener('wb-fw-mode-changed', onChange);
  }, []);

  // Standalone build only: probe the online configurator's sw.js — the same
  // file the normal in-browser update path uses. We load it via <script src=>
  // (no CORS preflight, unlike fetch — the deveditor.wirenboard.com bucket
  // doesn't send Access-Control-Allow-Origin). sw.js assigns its version
  // marker to self.__WB_BUILD_ID__ so we can read it after onload.
  const [remoteVersion, setRemoteVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!__APP_OFFLINE_BUILD__) return;
    const s = document.createElement('script');
    s.src = `https://deveditor.wirenboard.com/sw.js?ts=${Date.now()}`;
    const timer = setTimeout(() => s.remove(), 5000);
    const finish = () => { clearTimeout(timer); s.remove(); };
    s.onload = () => {
      const win = window as unknown as { __WB_APP_VERSION__?: string };
      // Compare the semver from package.json, not the git build hash —
      // otherwise we'd nag users about every cache-invalidation rebuild
      // within the same released version.
      if (win.__WB_APP_VERSION__ && win.__WB_APP_VERSION__ !== __APP_VERSION__) {
        setRemoteVersion(win.__WB_APP_VERSION__);
      }
      finish();
    };
    s.onerror = finish;
    document.head.appendChild(s);
    return finish;
  }, []);

  useEffect(() => {
    if (!navigator.serviceWorker?.controller) return;

    const checkOnline = () => {
      fetch('/sw-ping')
        .then((r) => r.text())
        .then((text) => setIsOffline(text === 'offline'))
        .catch(() => {});
    };

    checkOnline();
    const interval = setInterval(checkOnline, 30000);
    window.addEventListener('online', checkOnline);
    window.addEventListener('offline', checkOnline);
    return () => {
      clearInterval(interval);
      window.removeEventListener('online', checkOnline);
      window.removeEventListener('offline', checkOnline);
    };
  }, []);

  const {
    moduleInitialized,
    progress,
    loadingProgress,
    selectPort,
    getPortInfo,
    setExtendedTimeout,
    scan,
    bootScan,
    stopBootScan,
    findDevice,
    scanMessage,
    scanCount,
    bootScanMessage,
    bootScanCount,
    bootScanType,
    bootScanProgress,
    loadConfig,
    configGetDeviceTypes,
    configGetSchema,
    save,
    deviceLoad,
    portSetup,
    fwUpdateProxy,
    subscribeFwUpdateState,
  } = useModule(isOffline);

  const [deviceFwVersion, setDeviceFwVersion] = useState<string | null>(null);
  const [portName, setPortName] = useState<string | null>(null);
  const [saveCounter, setSaveCounter] = useState(0);
  const [portError, setPortError] = useState<string | null>(null);
  const [portNotSelected, setPortNotSelected] = useState(false);
  const [isPortScanning, setIsPortScanning] = useState(false);
  const [isBootScanning, setIsBootScanning] = useState(false);
  const bootScanRequestedRef = useRef(false);

  const refreshPortInfo = useCallback(async () => {
    try {
      const info = await getPortInfo();
      setPortName(info.name);
    } catch (err) {
      setPortError(err instanceof Error ? err.message : String(err));
    }
  }, [getPortInfo]);

  useEffect(() => {
    if (moduleInitialized) refreshPortInfo();
  }, [moduleInitialized, refreshPortInfo]);

  useEffect(() => {
    return subscribeFwUpdateState((state: any) => {
      if (!tabstore) return;
      const deviceState = state.devices?.find(
        (d: any) => d.slave_id === selectedDevice,
      );
      if (!deviceState) return;
      const device = allDevices.find((d) => d.cfg.slave_id === selectedDevice);
      if (!device) return;
      tabstore.setEmbeddedSoftwareUpdateProgress(deviceState, getPortConfig(device.cfg));
    });
  }, [subscribeFwUpdateState, tabstore, allDevices, selectedDevice]);

  const isUpdating = tabstore?.embeddedSoftware?.isUpdating ?? false;
  const isBusy = isUpdating || isConfigLoading;

  useEffect(() => {
    if (!isUpdating) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isUpdating]);

  const handleSelectPort = useCallback(async () => {
    try {
      setPortError(null);
      await selectPort();
      setPortNotSelected(false);
      await refreshPortInfo();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') {
        return; // User cancelled the port picker dialog
      }
      setPortError(err instanceof Error ? err.message : String(err));
    }
  }, [selectPort, refreshPortInfo]);

  const reset = () => {
    setDevices([]);
    setTabstore(null);
  };

  const configDeviceTypes = async () => {
    return configGetDeviceTypes(language).then((res) => {
      const deviceTypesStore = new DeviceTypesStore(configGetSchema);
      deviceTypesStore.setDeviceTypeGroups(res);
      setConfigDeviceTypesStore(deviceTypesStore);
      return deviceTypesStore;
    });
  };

  useEffect(() => {
    setReactLocale();
  }, []);

  useEffect(() => {
    if (moduleInitialized) {
      configDeviceTypes().then((store) => {
        if (selectedDevice) {
          const device = getDevice();
          if (!device.bootloader_mode) {
            loadDeviceSettings(device, store);
          } else {
            const tabStore = new DeviceTabStore(
              { slave_id: String(device.cfg.slave_id) },
              '',
              store,
              fwUpdateProxy,
              { LoadConfig: () => Promise.resolve({}) },
            );
            setTabstore(tabStore);
          }
        }
      });
    }
  }, [moduleInitialized, language]);

  const [slaveIdInvalid, setSlaveIdInvalid] = useState(false);

  // Slave_id validation — range check + duplicate detection
  useEffect(() => {
    setSlaveIdInvalid(false);
    if (!tabstore?.schemaStore) return;
    const slaveIdParam = tabstore.schemaStore.commonParams.getParamByKey('slave_id');
    if (!slaveIdParam) return;
    return autorun(() => {
      const editedSlaveId = tabstore.editedData?.slave_id;
      if (editedSlaveId === undefined || editedSlaveId === '') {
        tabstore.setSlaveIdIsDuplicate(false);
        setSlaveIdInvalid(false);
        return;
      }
      const num = Number(editedSlaveId);
      // Range validation: must be integer 1-247
      if (Number.isInteger(num) && (num < 1 || num > 247)) {
        tabstore.setSlaveIdIsDuplicate(false);
        slaveIdParam.store.error = { key: 'wasm.errors.invalid-slave-id' };
        setSlaveIdInvalid(true);
        return;
      }
      // Clear range error if value is now valid
      if (slaveIdParam.store.error?.key === 'wasm.errors.invalid-slave-id') {
        slaveIdParam.store.error = undefined;
      }
      setSlaveIdInvalid(false);
      // Duplicate detection
      const isDuplicate = Number.isInteger(num) && allDevices.some(
        (d) => d.cfg.slave_id === num && d.cfg.slave_id !== selectedDevice,
      );
      tabstore.setSlaveIdIsDuplicate(isDuplicate);
    });
  }, [tabstore, allDevices, selectedDevice]);

  const showScanResults = (allDevices: Device[]) => {
    refreshPortInfo();
    const firstDevice = allDevices.at(0);
    setSelectedDevice(firstDevice?.cfg.slave_id);
    setDevices(allDevices);
    if (firstDevice && !firstDevice.bootloader_mode) {
      loadDeviceSettings(firstDevice, configDeviceTypesStore);
    } else if (firstDevice) {
      const store = new DeviceTabStore(
        { slave_id: String(firstDevice.cfg.slave_id) },
        '',
        configDeviceTypesStore,
        fwUpdateProxy,
        { LoadConfig: () => Promise.resolve({}) },
      );
      setTabstore(store);
    }
  };

  const handleScan = async () => {
    reset();
    bootScanRequestedRef.current = false;

    // If no granted ports match — prompt user to pick one first.
    // Without this check, the WASM scan would itself trigger the picker
    // and cancellation would surface from deep inside an async loop.
    const info = await getPortInfo();
    if (info.matchingCount === 0) {
      try {
        await selectPort();
        setPortNotSelected(false);
        await refreshPortInfo();
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotFoundError') {
          setPortNotSelected(true);
          return;
        }
        setPortError(err instanceof Error ? err.message : String(err));
        return;
      }
    }

    setIsPortScanning(true);
    try {
      const res = await scan();

      if (bootScanRequestedRef.current) {
        setIsBootScanning(true);
        const bootDevices = await bootScan();
        setIsBootScanning(false);
        showScanResults([...res, ...bootDevices]);
      } else {
        showScanResults(res);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') {
        setPortNotSelected(true);
      } else {
        setPortError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setIsPortScanning(false);
      setIsBootScanning(false);
    }
  };

  const handleStopBootScan = () => {
    stopBootScan();
  };

  const [handleRestore, isRestoring] = useAsyncAction(async () => {
    try {
      const selectedDev = getDevice(selectedDevice);
      setExtendedTimeout(true);
      await fwUpdateProxy.Restore({
        slave_id: selectedDevice,
        protocol: 'modbus',
        port: getPortConfig(selectedDev.cfg),
      });
      tabstore.embeddedSoftware.firmware.updateProgress = 100;
      await new Promise((r) => setTimeout(r, 2500));

      if (selectedDevice !== 0) {
        const info = await findDevice(selectedDev.cfg);
        const updatedCfg = info.cfg ? { ...selectedDev.cfg, ...info.cfg } : selectedDev.cfg;
        const updatedDevice = { ...selectedDev, ...info, cfg: updatedCfg, bootloader_mode: false };
        setDevices((prev) => prev.map((d) =>
          d.cfg.slave_id === selectedDevice ? updatedDevice : d,
        ));
        loadDeviceSettings(updatedDevice, configDeviceTypesStore);
      } else {
        // Broadcast restore — rescan to find the device at its real address
        reset();
        bootScanRequestedRef.current = false;
        setIsPortScanning(true);
        const res = await scan();
        setIsPortScanning(false);
        showScanResults(res);
      }
    } catch (err) {
      tabstore.embeddedSoftware.firmware.updateProgress = null;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExtendedTimeout(false);
    }
  });

  const getType = (device: Device) => {
    return configDeviceTypesStore.findNotDeprecatedDeviceTypes(
      device.device_signature,
      device.fw?.version,
    ).at(0) || device.device_signature;
  };

  const loadDeviceSettings = useCallback(async (device: Device, deviceTypesStore = configDeviceTypesStore) => {
    setError(null);
    const deviceType = getType(device);

    setIsConfigLoading(true);

    const initialData = { slave_id: String(device.cfg.slave_id) };
    const cfg = { device_type: deviceType, ...device.cfg };
    const store = new DeviceTabStore(
      initialData,
      deviceType,
      deviceTypesStore,
      fwUpdateProxy,
      {
        LoadConfig: () => loadConfig(cfg).then((res) => {
          if (res.error) {
            return Promise.reject(res.error);
          }
          if (res.result?.fw) {
            setDeviceFwVersion(res.result.fw);
          }
          return res.result;
        }).catch((err) => {
          setError(err.message);
        }),
      },
    );
    await store.loadContent(device.cfg);
    store.setDeviceType(device.device_signature, cfg);
    store.updateEmbeddedSoftwareVersion(getPortConfig(device.cfg));
    store.schemaStore.customChannels = null;

    setTabstore(store);
    setIsConfigLoading(false);
    refreshPortInfo();
  }, [configDeviceTypesStore, refreshPortInfo]);

  const getDevice = useCallback((slaveId: number = selectedDevice) => {
    return allDevices.find((device) => device.cfg.slave_id === slaveId) || {};
  }, [allDevices, selectedDevice]);

  const getPortConfig = useCallback((deviceCfg: any) => ({
    path: 'wasm',
    baudRate: deviceCfg?.baud_rate || 9600,
    stopBits: deviceCfg?.stop_bits || 2,
    parity: deviceCfg?.parity || 'N',
    dataBits: deviceCfg?.data_bits || 8,
  }), []);

  const handleSave = async () => {
    const device = getDevice();
    if (!device.cfg || !tabstore?.editedData) return;
    setIsSaving(true);
    setError(null);
    try {
      const editedSlaveId = Number(tabstore.editedData.slave_id);
      const originalSlaveId = device.cfg.slave_id;

      // If slave_id changed on a WB device, write new address to register 0x80
      const slaveIdChanged = Number.isInteger(editedSlaveId)
        && editedSlaveId >= 1 && editedSlaveId <= 247
        && editedSlaveId !== originalSlaveId;
      if (slaveIdChanged && configDeviceTypesStore.isWbDevice(getType(device))) {
        const setupRequest = {
          items: [{
            slave_id: originalSlaveId,
            baud_rate: device.cfg.baud_rate,
            data_bits: device.cfg.data_bits,
            parity: device.cfg.parity,
            stop_bits: device.cfg.stop_bits,
            cfg: { slave_id: editedSlaveId },
          }],
        };
        const result = await portSetup(setupRequest);
        if (result.error) {
          setError(result.error.message);
          return;
        }
        // Update local device state with new slave_id
        setDevices((prev) =>
          prev.map((d) =>
            d.cfg.slave_id === originalSlaveId
              ? { ...d, cfg: { ...d.cfg, slave_id: editedSlaveId } }
              : d,
          ),
        );
        setSelectedDevice(editedSlaveId);
      }

      // Save other parameters (addressing the device at its current slave_id)
      const { slave_id, device_type, ...parameters } = tabstore.editedData;

      // Filter out readonly parameters that the backend rejects
      const schema = await configDeviceTypesStore.getSchema(tabstore.deviceType);
      const deviceTemplate = schema?.device as any;
      if (deviceTemplate?.parameters) {
        for (const param of deviceTemplate.parameters) {
          if (param.readonly) {
            delete parameters[param.id];
          }
        }
      }

      const data = {
        device_type: tabstore.deviceType,
        ...device.cfg,
        ...(slaveIdChanged ? { slave_id: editedSlaveId } : {}),
        parameters,
      };

      const result = await save(data);
      if (result?.error) {
        setError(result.error.message);
      } else {
        setSaveCounter((c) => c + 1);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const addDevice = (device: Device) => {
    const devices = JSON.parse(localStorage.getItem('devices')) || [];
    updateManualDevices([...devices, device]);
    setIsModalOpened(false);
  };

  const saveLocal = () => {
    const devices = JSON.parse(localStorage.getItem('devices')) || [];
    updateManualDevices([...devices, getDevice()]);
  };

  const removeLocal = (id = selectedDevice) => {
    const isRealDevice = !!devices.find(({ cfg }) => cfg.slave_id === id);
    if (!isRealDevice) {
      setTabstore(null);
      setError(null);
    }
    let res = (JSON.parse(localStorage.getItem('devices')) || [])
      .filter((device) => device.cfg.slave_id !== id);
    updateManualDevices(res);
  };

  return (
    <PageLayout
      title={t('wasm.title')}
      actions={
        <>
          {isOffline && <span className="deviceSettingsWasm-offline">{t('wasm.sw.offline')}</span>}
          {hasUpdate && (
            <a
              className="deviceSettingsWasm-update"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                window.location.reload();
              }}
            >
              {t('wasm.sw.update-available')}
            </a>
          )}
          <Button
            label={t('wasm.buttons.add-device')}
            variant="secondary"
            disabled={isBusy}
            onClick={() => setIsModalOpened(true)}
          />
          <Button
            label={portName ? `${t('wasm.buttons.select')} (${portName})` : t('wasm.buttons.select')}
            variant="secondary"
            disabled={isBusy}
            onClick={handleSelectPort}
          />
          <Button label={t('wasm.buttons.scan')} disabled={isBusy} onClick={handleScan} />
          <Button
            label={t('wasm.buttons.save')}
            disabled={!tabstore || !allDevices.length || tabstore?.slaveIdIsDuplicate
              || slaveIdInvalid || isBusy || isSaving}
            variant="primary"
            isLoading={isSaving}
            onClick={handleSave}
          />
          <Dropdown
            options={[
              { label: 'EN', value: 'en' },
              { label: 'RU', value: 'ru' },
            ]}
            value={language}
            onChange={(option: Option<string>) => {
              localStorage.setItem('language', option.value);
              setLanguage(option.value);
              setReactLocale();
            }}
          />
        </>
      }
      isLoading={(!configDeviceTypesStore && loadingProgress?.percent !== 100) || !moduleInitialized}
      loadingOptions={{
        loader: loadingProgress?.percent !== 100 ? 'progress' : 'spinner',
        progress: loadingProgress?.percent,
        label: loadingProgress?.percent !== 100
          ? `${formatBytes(loadingProgress?.loaded)} / ${formatBytes(loadingProgress?.total)}`
          : null,
      }}
      footer={
        <div className="deviceSettingsWasm-footer">
          <a href="https://wirenboard.com" target="_blank">
            <img src="./img/logo-wide.svg" className="deviceSettingsWasm-logo" loading="eager" alt="Wiren Board" />
          </a>
          <span className="deviceSettingsWasm-version">
            v{__APP_VERSION__}{__APP_OFFLINE_BUILD__ ? ` ${t('wasm.version.standalone-suffix')}` : ''}
          </span>
        </div>
      }
      hasRights
    >
      {isTesting && isTestingAlertVisible && (
        <Alert
          className="deviceSettingsWasm-alert"
          variant="warn"
          onClose={() => setIsTestingAlertVisible(false)}
        >
          {t('wasm.release.testing-banner')}{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); setIsReleaseConfirmOpen(true); }}>
            {t('wasm.release.switch-to-stable-link')}
          </a>.
        </Alert>
      )}
      {remoteVersion && (
        <Alert className="deviceSettingsWasm-alert" variant="info">
          {t('wasm.version.update-available', { version: remoteVersion })}{' '}
          <a href="https://deveditor.wirenboard.com/" target="_blank" rel="noreferrer">
            {t('wasm.version.open-online')}
          </a>
          {' '}/{' '}
          <a href="https://deveditor.wirenboard.com/offline/index.html" target="_blank" rel="noreferrer">
            {t('wasm.version.download-standalone')}
          </a>.
        </Alert>
      )}
      {isFwOffline && (
        <Alert className="deviceSettingsWasm-alert" variant="info">
          {t('wasm.offline-fw.banner')}
        </Alert>
      )}
      {portError && (
        <Alert
          className="deviceSettingsWasm-alert"
          variant="warn"
          onClose={() => setPortError(null)}
        >
          {t('wasm.errors.select-port-failed', { error: portError })}
        </Alert>
      )}
      {portNotSelected && (
        <Alert
          className="deviceSettingsWasm-alert"
          variant="warn"
          onClose={() => setPortNotSelected(false)}
        >
          <span dangerouslySetInnerHTML={{ __html: t('wasm.errors.port-not-selected') }} />
        </Alert>
      )}
      <ScanProgress
        isPortScanning={isPortScanning}
        isBootScanning={isBootScanning}
        progress={progress}
        scanMessage={scanMessage}
        scanCount={scanCount}
        bootScanProgress={bootScanProgress ?? 0}
        bootScanMessage={bootScanMessage}
        bootScanCount={bootScanCount}
        bootScanType={bootScanType}
        bootScanRequestedRef={bootScanRequestedRef}
        onStopBootScan={handleStopBootScan}
      />
      {!isPortScanning && !isBootScanning && (
        <main className="deviceSettingsWasm-container">
          <aside className={classNames('deviceSettingsWasm-aside', { 'deviceSettingsWasm-aside--disabled': isBusy })}>
            {!!(devices.length || manualDevices.length) && (
              <Tabs
                items={allDevices
                  .map((device) => ({
                    id: device.cfg.slave_id,
                    label: device.bootloader_mode
                      ? (
                        <span>
                          {device.slave_id === 0 ? '[0]' : device.cfg.slave_id}
                          {' '}{device.fw_signature} <WarnIcon className="deviceSettingsWasm-warnIcon" />
                        </span>
                      )
                      : `${device.cfg.slave_id} ${configDeviceTypesStore?.getName(getType(device))}`,
                  }))}
                activeTab={activeTab}
                onTabChange={(id: number) => {
                  if (isBusy) return;
                  const device = getDevice(id);
                  setSelectedDevice(id);
                  if (!device.bootloader_mode) {
                    loadDeviceSettings(device, configDeviceTypesStore);
                  } else {
                    const store = new DeviceTabStore(
                      { slave_id: String(device.cfg.slave_id) },
                      '',
                      configDeviceTypesStore,
                      fwUpdateProxy,
                      { LoadConfig: () => Promise.resolve({}) },
                    );
                    setTabstore(store);
                  }
                }}
              />
            )}

          </aside>
          <section className="deviceSettingsWasm-content">
            {error && (
              <Alert
                className="deviceSettingsWasm-alert"
                variant="danger"
              >
                {t('device-manager.errors.load-registers', { error })}
              </Alert>
            )}
            {(() => {
              const selectedDev = getDevice(selectedDevice);
              if (selectedDev?.bootloader_mode && tabstore) {
                return (
                  <BootloaderDeviceView
                    selectedDevice={selectedDevice}
                    fwSignature={selectedDev.fw_signature}
                    embeddedSoftware={tabstore.embeddedSoftware}
                    isRestoring={isRestoring}
                    onRestore={handleRestore}
                  />
                );
              }
              return null;
            })()}
            {isConfigLoading ? (
              <div className="deviceSettingsWasm-loaderWrapper">
                <Loader caption={t('device-manager.labels.reading-parameters')} />
              </div>
            ) : (
              !allDevices.length && !isPortScanning && moduleInitialized ? (
                <div className="deviceSettingsWasm-emptyState">
                  <Alert variant="info">
                    {t('wasm.labels.empty-state')}
                  </Alert>
                </div>
              ) : (
                <DeviceSettingsView
                  tabstore={tabstore}
                  isBusy={isBusy}
                  isLocal={manualDevices.map((device) => device.cfg.slave_id).includes(selectedDevice)}
                  deviceFwVersion={deviceFwVersion}
                  saveCounter={saveCounter}
                  deviceCfg={{ ...getDevice().cfg, device_type: tabstore?.deviceType }}
                  deviceLoad={deviceLoad}
                  save={save}
                  configGetSchema={configGetSchema}
                  onSaveLocal={saveLocal}
                  onRemoveLocal={() => removeLocal()}
                  onReload={() => loadDeviceSettings(getDevice(), configDeviceTypesStore)}
                  onUpdateFirmware={() => {
                    setExtendedTimeout(true);
                    tabstore.embeddedSoftware.startFirmwareUpdate(tabstore.slaveId, getPortConfig(getDevice().cfg))
                      .finally(() => setExtendedTimeout(false));
                  }}
                  onUpdateBootloader={() => {
                    setExtendedTimeout(true);
                    tabstore.embeddedSoftware.startBootloaderUpdate(tabstore.slaveId, getPortConfig(getDevice().cfg))
                      .finally(() => setExtendedTimeout(false));
                  }}
                  onUpdateComponents={() => {
                    setExtendedTimeout(true);
                    tabstore.embeddedSoftware.startComponentsUpdate(tabstore.slaveId, getPortConfig(getDevice().cfg))
                      .finally(() => setExtendedTimeout(false));
                  }}
                />
              )
            )}
          </section>
        </main>
      )}

      {isModalOpened && (
        <AddDevice
          isOpened={isModalOpened}
          deviceTypes={configDeviceTypesStore?.deviceTypeDropdownOptions || []}
          onSave={addDevice}
          onClose={() => setIsModalOpened(false)}
        />
      )}
      <div className="deviceSettingsWasm-bottomLinks">
        {!__APP_OFFLINE_BUILD__ && (
          <>
            <a href="/offline/index.html" target="_blank" rel="noreferrer">
              {t('wasm.offline-download.link')}
            </a>
            <span className="deviceSettingsWasm-bottomLinks-sep">|</span>
          </>
        )}
        <ReleaseSwitcher nextRelease={nextRelease} onClick={() => setIsReleaseConfirmOpen(true)} />
      </div>
      <Confirm
        isOpened={isReleaseConfirmOpen}
        heading={t(`wasm.release.switch-to-${nextRelease}-title`)}
        acceptLabel={t('wasm.release.switch')}
        cancelLabel={t('wasm.release.cancel')}
        variant={nextRelease === 'testing' ? 'warn' : 'primary'}
        confirmCallback={applyRelease}
        closeCallback={() => setIsReleaseConfirmOpen(false)}
      >
        {t(`wasm.release.switch-to-${nextRelease}-text`)}
      </Confirm>
    </PageLayout>
  );
});
