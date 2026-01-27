import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/alert';
import { Button } from '@/components/button';
import { Dropdown, type Option } from '@/components/dropdown';
import { Loader } from '@/components/loader';
import { Progress } from '@/components/progress';
import { Tabs, useTabs } from '@/components/tabs';
import { PageLayout } from '@/layouts/page';
import { DeviceSettingsEditor, FirmwareVersionPanel } from '@/pages/settings/device-manager';
import { DeviceTabStore, DeviceTypesStore } from '@/stores/device-manager';
import { setReactLocale } from '~/react-directives/locale';
import { useLocalStorage } from '../utils/useLocalStorage';
import { AddDevice } from './components/add-device';
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
  const [manualDevices, updateManualDevices] = useLocalStorage('devices');
  const allDevices = useMemo(() => [...devices, ...(devices.length ? manualDevices.filter((device) => {
    return !devices.map((device) => device.cfg.slave_id).includes(device.cfg.slave_id);
  }) : manualDevices)], [devices, manualDevices]);
  const { activeTab } = useTabs({
    defaultTab: selectedDevice,
    items: allDevices,
  });

  const {
    moduleInitialized,
    progress,
    selectPort,
    scan,
    scanMessage,
    loadConfig,
    configGetDeviceTypes,
    configGetSchema,
    save,
  } = useModule();

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

    setTabstore(store);
    setIsConfigLoading(false);
  }, [configDeviceTypesStore]);

  const getDevice = useCallback((slaveId: number = selectedDevice) => {
    return allDevices.find((device) => device.cfg.slave_id === slaveId) || {};
  }, [allDevices, selectedDevice]);

  const handleSave = () => {
    const data = {
      device_type: tabstore.deviceType,
      ...getDevice().cfg,
      parameters: tabstore.editedData,
    };
    delete data.parameters.slave_id;

    save(data);
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
          <Button label={t('wasm.buttons.add-device')} variant="secondary" onClick={() => setIsModalOpened(true)}/>
          <Button label={t('wasm.buttons.select')} variant="secondary" onClick={selectPort} />
          <Button label={t('wasm.buttons.scan')} onClick={handleScan} />
          <Button label={t('wasm.buttons.save')} disabled={!devices.length} variant="primary" onClick={handleSave} />
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
            tabstore && (
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
                <DeviceSettingsEditor
                  store={tabstore.schemaStore}
                  translator={tabstore.schemaStore?.schemaTranslator}
                  showChannels={false}
                />
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
