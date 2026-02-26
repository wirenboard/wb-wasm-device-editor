import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/alert';
import { Button } from '@/components/button';
import { Dropdown, type Option } from '@/components/dropdown';
import { JsonSchemaEditor } from '@/components/json-schema-editor';
import { Loader } from '@/components/loader';
import { Progress } from '@/components/progress';
import { Tabs, TabContent, useTabs } from '@/components/tabs';
import { PageLayout } from '@/layouts/page';
import { FirmwareVersionPanel } from '@/pages/settings/device-manager';
import { MakeEditors } from '@/pages/settings/device-manager/components/device-settings-editor/device-settings-param-editor';
import {
  DeviceTabStore,
  DeviceTypesStore,
  type WbDeviceParameterEditorsGroup,
} from '@/stores/device-manager';
import type { Translator } from '@/stores/json-schema-editor';
import { setReactLocale } from '~/react-directives/locale';
import { useLocalStorage } from '../utils/useLocalStorage';
import { AddDevice } from './components/add-device';
import { RuntimeView } from './components/runtime-view';
import { useModule } from './module';
import type { Device } from './types';
import './styles.css';

const RUNTIME_VIEW_TAB_ID = 'runtime-view';

const SubGroupContent = observer((
  { group, translator }: { group: WbDeviceParameterEditorsGroup; translator: Translator }
) => {
  const { i18n } = useTranslation();
  const currentLanguage = i18n.language;
  return (
    <div className="deviceSettingsEditor-subGroup">
      {!group.properties.ui_options?.wb?.disable_title && (
        <label>{translator.find(group.properties.title, currentLanguage)}</label>
      )}
      <div className={classNames({
        'deviceSettingsEditor-subGroupContent': true,
        'deviceSettingsEditor-subGroupContentWithBorder': !group.properties.ui_options?.wb?.disable_title,
      })}>
        {MakeEditors(group.parameters, translator)}
        {group.subgroups.map((sub) => (
          sub.isEnabledByCondition
            ? <SubGroupContent key={sub.properties.id} group={sub} translator={translator} />
            : null
        ))}
      </div>
    </div>
  );
});

const SettingsTabContent = observer((
  { group, translator }: { group: WbDeviceParameterEditorsGroup; translator: Translator }
) => {
  const { i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const showDescription = !!group.properties.description;
  return (
    <div className="deviceSettingsEditor-topGroupContent">
      {showDescription && (
        <p className="wb-jsonEditor-propertyDescription">
          {translator.find(group.properties.description, currentLanguage)}
        </p>
      )}
      {MakeEditors(group.parameters, translator)}
      {group.subgroups.map((sub) => (
        sub.isEnabledByCondition
          ? <SubGroupContent key={sub.properties.id} group={sub} translator={translator} />
          : null
      ))}
    </div>
  );
});

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
  const [manualDevices, updateManualDevices] = useLocalStorage('devices');
  const allDevices = useMemo(() => [...devices, ...(devices.length ? manualDevices.filter((device) => {
    return !devices.map((device) => device.cfg.slave_id).includes(device.cfg.slave_id);
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
    selectPort,
    getPortInfo,
    scan,
    scanMessage,
    loadConfig,
    configGetDeviceTypes,
    configGetSchema,
    save,
    deviceLoad,
  } = useModule();

  const [portName, setPortName] = useState<string | null>(null);
  const [portHexId, setPortHexId] = useState<string | null>(null);
  const [multiplePortsAvailable, setMultiplePortsAvailable] = useState(false);
  const [saveCounter, setSaveCounter] = useState(0);

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

  const handleSelectPort = useCallback(async () => {
    await selectPort();
    await refreshPortInfo();
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

  const handleScan = async () => {
    reset();
    const res = await scan();
    refreshPortInfo();
    const firstDevice = res.at(0);
    setSelectedDevice(firstDevice?.cfg.slave_id);

    setDevices(res);

    loadDeviceSettings(firstDevice, configDeviceTypesStore);
  };

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
      { GetFirmwareInfo: () => ({ fw: device.fw?.version }), hasMethod: () => true },
      {
        LoadConfig: () => loadConfig(cfg).then((res) => {
          if (res.error) {
            return Promise.reject(res.error);
          }
          return res.result;
        }).catch((err) => {
          setError(err.message);
        }),
      },
    );
    await store.loadContent(device.cfg);
    store.setDeviceType(device.device_signature, cfg);
    await store.updateEmbeddedSoftwareVersion(device.cfg);
    store.schemaStore.customChannels = null;

    setTabstore(store);
    setIsConfigLoading(false);
    refreshPortInfo();
  }, [configDeviceTypesStore, refreshPortInfo]);

  const getDevice = useCallback((slaveId: number = selectedDevice) => {
    return allDevices.find((device) => device.cfg.slave_id === slaveId) || {};
  }, [allDevices, selectedDevice]);

  const handleSave = async () => {
    const data = {
      device_type: tabstore.deviceType,
      ...getDevice().cfg,
      parameters: tabstore.editedData,
    };
    delete data.parameters.slave_id;

    const result = await save(data);
    if (result?.error) {
      setError(result.error.message);
    } else {
      setSaveCounter((c) => c + 1);
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
  const settingsGroups: WbDeviceParameterEditorsGroup[] = schemaStore?.topLevelGroup?.subgroups || [];

  const settingsTabs = useMemo(() => {
    if (!settingsGroups.length) return [];
    return settingsGroups
      .filter((group) => !!(group.parameters.length + group.subgroups.length))
      .map((group) => ({
        id: group.properties.id,
        label: (
          <span className={classNames({
            'deviceSettingsEditor-tabWithError': group.hasErrors,
            'deviceSettingsEditor-tabWithWarning': group.hasBadValuesFromRegisters && !group.hasErrors,
          })}>
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
          <Button label={t('wasm.buttons.add-device')} variant="secondary" onClick={() => setIsModalOpened(true)}/>
          {portName ? (
            <>
              <span className="deviceSettingsWasm-portName">
                <span>{portName}</span>
                <span>{portHexId}</span>
              </span>
              {multiplePortsAvailable && (
                <Button label={t('wasm.buttons.change-port')} variant="secondary" onClick={handleSelectPort} />
              )}
            </>
          ) : (
            <Button label={t('wasm.buttons.select')} variant="secondary" onClick={handleSelectPort} />
          )}
          <Button label={t('wasm.buttons.scan')} onClick={handleScan} />
          <Button
            label={t('wasm.buttons.save')}
            disabled={!tabstore || !allDevices.length}
            variant="primary"
            onClick={handleSave}
          />
        </>
      }
      isLoading={!configDeviceTypesStore}
      footer={
        <div className="deviceSettingsWasm-footer">
          <a href="https://wirenboard.com" target="_blank">
            <img src="./img/logo-wide.svg" className="deviceSettingsWasm-logo" loading="eager" alt="Wiren Board" />
          </a>
          <Dropdown
            options={[
              { label: 'English', value: 'en' },
              { label: 'Русский', value: 'ru' },
            ]}
            value={language}
            onChange={(option: Option<string>) => {
              localStorage.setItem('language', option.value);
              setLanguage(option.value);
              setReactLocale();
            }}
          />
        </div>
      }
      hasRights
    >
      {progress !== 0 && progress < 100 && (
        <>
          <Progress value={progress} caption={progress.toFixed() + '%'} />
          <div className="deviceSettingsWasm-scanning">{t('wasm.labels.scanning', { message: scanMessage })}</div>
        </>
      )}
      <main className="deviceSettingsWasm-container">
        <aside className="deviceSettingsWasm-aside">
          {!!(devices.length || manualDevices.length) && (
            <Tabs
              items={allDevices
                .map((device) => ({
                  id: device.cfg.slave_id,
                  label: `${device.cfg.slave_id} ${configDeviceTypesStore?.getName(getType(device))}`,
                }))}
              activeTab={activeTab}
              onTabChange={(id: number) => {
                const device = getDevice(id);
                setSelectedDevice(id);
                loadDeviceSettings(device, configDeviceTypesStore);
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
          {isConfigLoading ? (
            <div className="deviceSettingsWasm-loaderWrapper">
              <Loader caption={t('device-manager.labels.reading-parameters')} />
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
                        onClick={() => removeLocal()}
                      />
                    )
                    : (
                      <Button
                        label={t('wasm.buttons.save-local')}
                        variant="secondary"
                        size="small"
                        onClick={() => saveLocal()}
                      />
                    )
                  }

                </header>
                <FirmwareVersionPanel firmwareVersion={getDevice().fw?.version} />
                <div className="deviceSettingsEditor deviceSettingsEditor-desktop">
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
          )}
        </section>
      </main>

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
