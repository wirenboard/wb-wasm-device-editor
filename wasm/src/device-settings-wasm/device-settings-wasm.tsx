import classNames from 'classnames';
import { autorun } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAsyncAction } from '@/utils/async-action';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/alert';
import WarnIcon from '@/assets/icons/warn.svg';
import { Button } from '@/components/button';
import { Dropdown, type Option } from '@/components/dropdown';
import { JsonSchemaEditor } from '@/components/json-schema-editor';
import { Loader } from '@/components/loader';
import { Progress } from '@/components/progress';
import { Tabs, TabContent, useTabs } from '@/components/tabs';
import { PageLayout } from '@/layouts/page';
import { EmbeddedSoftwarePanel } from '@/pages/settings/device-manager';
import {
  MakeEditors,
} from '@/pages/settings/device-manager/components/device-settings-editor/device-settings-param-editor';
import {
  DeviceTabStore,
  DeviceTypesStore,
  type WbDeviceParameterEditorsGroup,
} from '@/stores/device-manager';
import { setReactLocale } from '~/react-directives/locale';
import { formatBytes } from '../utils/format-bytes';
import { useLocalStorage } from '../utils/useLocalStorage';
import { AddDevice } from './components/add-device';
import { RuntimeView } from './components/runtime-view';
import { SettingsTabContent } from './components/tab-content';
import { useModule } from './module';
import type { Device } from './types';
import './styles.css';

const RUNTIME_VIEW_TAB_ID = 'runtime-view';
const EMPTY_GROUPS: WbDeviceParameterEditorsGroup[] = [];

export const DeviceSettingsWasm = observer(() => {
  const { t, i18n } = useTranslation();
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

  useEffect(() => {
    const onUpdate = () => setHasUpdate(true);
    window.addEventListener('sw-update-available', onUpdate);
    return () => window.removeEventListener('sw-update-available', onUpdate);
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
    scan,
    bootScan,
    stopScan,
    stopBootScan,
    readDeviceInfo,
    scanMessage,
    scanCount,
    bootScanMessage,
    bootScanCount,
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
  const [portHexId, setPortHexId] = useState<string | null>(null);
  const [multiplePortsAvailable, setMultiplePortsAvailable] = useState(false);
  const [saveCounter, setSaveCounter] = useState(0);
  const [portError, setPortError] = useState<string | null>(null);
  const [isPortScanning, setIsPortScanning] = useState(false);
  const [isBootScanning, setIsBootScanning] = useState(false);
  const bootScanRequestedRef = useRef(false);

  const refreshPortInfo = useCallback(async () => {
    try {
      const info = await getPortInfo();
      setPortName(info.name);
      setPortHexId(info.hexId);
      setMultiplePortsAvailable(info.matchingCount > 1);
    } catch {}
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
          loadDeviceSettings(getDevice(), store);
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
    loadDeviceSettings(firstDevice, configDeviceTypesStore);
  };

  const handleScan = async () => {
    reset();
    setIsPortScanning(true);
    const res = await scan();

    if (bootScanRequestedRef.current) {
      setIsBootScanning(true);
      const bootDevices = await bootScan();
      console.log('Boot scan results:', bootDevices);
      setIsBootScanning(false);
      setIsPortScanning(false);
      showScanResults([...res, ...bootDevices]);
    } else {
      setIsPortScanning(false);
      showScanResults(res);
    }
  };

  const handleStopBootScan = () => {
    stopBootScan();
  };

  const [handleRestore, isRestoring] = useAsyncAction(async () => {
    try {
      const selectedDev = getDevice(selectedDevice);
      await fwUpdateProxy.Restore({ slave_id: selectedDevice, protocol: 'modbus' });
      tabstore.embeddedSoftware.firmware.updateProgress = 100;
      await new Promise((r) => setTimeout(r, 2500));
      const info = await readDeviceInfo(selectedDev.cfg);
      const updatedDevice = { ...selectedDev, ...info, bootloader_mode: false };
      setDevices((prev) => prev.map((d) =>
        d.cfg.slave_id === selectedDevice ? updatedDevice : d
      ));
      loadDeviceSettings(updatedDevice, configDeviceTypesStore);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

  // Build settings tabs from schemaStore groups + RuntimeView
  const schemaStore = tabstore?.schemaStore;
  const translator = schemaStore?.schemaTranslator;
  const settingsGroups: WbDeviceParameterEditorsGroup[] = schemaStore?.topLevelGroup?.subgroups || EMPTY_GROUPS;

  const settingsTabs = useMemo(() => {
    if (!settingsGroups.length) return [];
    return settingsGroups
      .filter((group) => !!(group.parameters.length + group.subgroups.length))
      .map((group) => ({
        id: group.properties.id,
        label: (
          <span
            className={classNames({
              'deviceSettingsEditor-tabWithError': group.hasErrors,
              'deviceSettingsEditor-tabWithWarning': group.hasBadValuesFromRegisters && !group.hasErrors,
            })}
          >
            {translator?.find(group.properties.title, i18n.language) ?? group.properties.title}
          </span>
        ),
      }));
  }, [settingsGroups, translator, i18n.language]);

  const allTabs = useMemo(() => [
    ...settingsTabs,
    { id: RUNTIME_VIEW_TAB_ID, label: t('wasm.labels.runtime-view') },
  ], [settingsTabs, t]);

  const {
    activeTab: activeSettingsTab,
    onTabChange: onSettingsTabChange,
  } = useTabs({
    defaultTab: settingsTabs[0]?.id,
    items: allTabs,
  });

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
          <Button label={t('wasm.buttons.add-device')} variant="secondary" onClick={() => setIsModalOpened(true)} disabled={isBusy} />
          <Button label={portName ? `${t('wasm.buttons.select')} (${portName})` : t('wasm.buttons.select')} variant="secondary" onClick={handleSelectPort} disabled={isBusy} />
          <Button label={t('wasm.buttons.scan')} onClick={handleScan} disabled={isBusy} />
          <Button
            label={t('wasm.buttons.save')}
            disabled={!tabstore || !allDevices.length || tabstore?.slaveIdIsDuplicate || slaveIdInvalid || isBusy || isSaving}
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
        </div>
      }
      hasRights
    >
      {portError && (
        <Alert
          className="deviceSettingsWasm-alert"
          variant="warn"
          onClose={() => setPortError(null)}
        >
          {t('wasm.errors.select-port-failed', { error: portError })}
        </Alert>
      )}
      {isPortScanning && !isBootScanning && (
        <>
          <Progress value={progress} caption={progress.toFixed() + '%'} />
          <div className="deviceSettingsWasm-scanning">{t('wasm.labels.scanning', { message: scanMessage })}</div>
          {!!scanCount && <div className="deviceSettingsWasm-scanning">{t('wasm.labels.found-devices', { count: scanCount })}…</div>}
          <label style={{ display: 'block', textAlign: 'center', cursor: 'pointer' }}>
            <input
              type="checkbox"
              style={{ cursor: 'pointer' }}
              onChange={(e) => { bootScanRequestedRef.current = e.target.checked; }}
            />
            {' '}{t('wasm.labels.boot-scan')}
          </label>
        </>
      )}
      {isBootScanning && (
        <>
          <Progress value={bootScanProgress ?? 0} caption={(bootScanProgress ?? 0).toFixed() + '%'} />
          <div className="deviceSettingsWasm-scanning">{t('wasm.labels.boot-scanning', { message: bootScanMessage })}</div>
          {!!bootScanCount && <div className="deviceSettingsWasm-scanning">{t('wasm.labels.found-devices', { count: bootScanCount })}…</div>}
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <Button label={t('wasm.buttons.stop')} size="small" variant="secondary" onClick={handleStopBootScan} />
          </div>
        </>
      )}
      {!isPortScanning && !isBootScanning && <main className="deviceSettingsWasm-container">
        <aside className={classNames('deviceSettingsWasm-aside', { 'deviceSettingsWasm-aside--disabled': isBusy })}>
          {!!(devices.length || manualDevices.length) && (
            <Tabs
              items={allDevices
                .map((device) => ({
                  id: device.cfg.slave_id,
                  label: device.bootloader_mode
                    ? <span>{device.cfg.slave_id} {device.fw_signature} <WarnIcon style={{ width: 16, height: 16, verticalAlign: 'text-bottom', color: '#d9534f' }} /></span>
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
                <>
                  <header className="deviceSettingsWasm-header">
                    <h3 className="deviceSettingsWasm-title">{selectedDevice} {selectedDev.fw_signature}</h3>
                  </header>
                  <EmbeddedSoftwarePanel
                    embeddedSoftware={tabstore.embeddedSoftware}
                    onUpdateFirmware={() => { }}
                    onUpdateBootloader={() => { }}
                    onUpdateComponents={() => { }}
                  />
                  {!tabstore.embeddedSoftware.isUpdating && (
                    <Alert variant="warn" className="hasUpdateAlert">
                      <div>
                        {t('wasm.labels.bootloader-device')}
                      </div>
                      <Button
                        label={t('wasm.buttons.restore')}
                        variant="warn"
                        isLoading={isRestoring}
                        disabled={isRestoring}
                        onClick={handleRestore}
                      />
                    </Alert>
                  )}
                </>
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
              tabstore && schemaStore && translator && (
                <>
                  <header className="deviceSettingsWasm-header">
                    <h3 className="deviceSettingsWasm-title">{tabstore.name}</h3>
                    {manualDevices.map((device) => device.cfg.slave_id).includes(selectedDevice)
                      ? (
                        <Button
                          label={t('wasm.buttons.remove-local')}
                          variant="secondary"
                          size="small"
                          disabled={isBusy}
                          onClick={() => removeLocal()}
                        />
                      )
                      : (
                        <Button
                          label={t('wasm.buttons.save-local')}
                          variant="secondary"
                          size="small"
                          disabled={isBusy}
                          onClick={() => saveLocal()}
                        />
                      )
                    }

                  </header>
                  <EmbeddedSoftwarePanel
                    embeddedSoftware={tabstore.embeddedSoftware}
                    onUpdateFirmware={() => tabstore.embeddedSoftware.startFirmwareUpdate(tabstore.slaveId, getPortConfig(getDevice().cfg))}
                    onUpdateBootloader={() => tabstore.embeddedSoftware.startBootloaderUpdate(tabstore.slaveId, getPortConfig(getDevice().cfg))}
                    onUpdateComponents={() => tabstore.embeddedSoftware.startComponentsUpdate(tabstore.slaveId, getPortConfig(getDevice().cfg))}
                  />
                  {!tabstore.embeddedSoftware.firmware.current && deviceFwVersion && (
                    <div className="firmwareVersionPanel">
                      <b>{t('device-manager.labels.current-firmware', { firmware: deviceFwVersion })}</b>
                    </div>
                  )}
                  {tabstore.slaveIdIsDuplicate && (
                    <Alert
                      className="deviceSettingsWasm-alert"
                      variant="danger"
                    >
                      {t('device-manager.errors.duplicate-slave-id')}
                    </Alert>
                  )}
                  <div className={classNames('deviceSettingsEditor', 'deviceSettingsEditor-desktop', { 'deviceSettingsWasm-aside--disabled': isBusy })}>
                    <JsonSchemaEditor store={schemaStore.commonParams} translator={translator} />
                    {MakeEditors(schemaStore.topLevelGroup.parameters, translator)}
                    {allTabs.length > 0 && (
                      <div className="deviceSettingsEditor-tabs">
                        <Tabs
                          activeTab={activeSettingsTab}
                          items={allTabs}
                          onTabChange={onSettingsTabChange}
                        />
                        {settingsGroups
                          .filter((group) => !!(group.parameters.length + group.subgroups.length))
                          .map((group) => (
                            <TabContent
                              key={group.properties.id}
                              activeTab={activeSettingsTab}
                              tabId={group.properties.id}
                              className="deviceSettingsEditor-tabContent"
                            >
                              <SettingsTabContent group={group} translator={translator} />
                            </TabContent>
                          ))
                        }
                        <TabContent
                          activeTab={activeSettingsTab}
                          tabId={RUNTIME_VIEW_TAB_ID}
                          className="deviceSettingsEditor-tabContent"
                        >
                          <RuntimeView
                            key={saveCounter}
                            deviceCfg={{ ...getDevice().cfg, device_type: tabstore.deviceType }}
                            deviceLoad={deviceLoad}
                            save={save}
                            configGetSchema={configGetSchema}
                          />
                        </TabContent>
                      </div>
                    )}
                  </div>
                </>
              )
            )
          )}
        </section>
      </main>}

      {isModalOpened && (
        <AddDevice
          isOpened={isModalOpened}
          deviceTypes={configDeviceTypesStore?.deviceTypeDropdownOptions || []}
          onSave={addDevice}
          onClose={() => setIsModalOpened(false)}
        />
      )}
    </PageLayout>
  );
});
