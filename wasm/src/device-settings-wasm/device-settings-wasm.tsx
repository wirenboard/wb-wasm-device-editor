import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/button';
import { Dropdown, type Option } from '@/components/dropdown';
import { Loader } from '@/components/loader';
import { Progress } from '@/components/progress';
import { Tabs, useTabs } from '@/components/tabs';
import { PageLayout } from '@/layouts/page';
import { setReactLocale } from '~/react-directives/locale';
import { FirmwareVersionPanel } from '@/pages/settings/device-manager/components/embedded-software-panel/embedded-software-panel';
import { DeviceTabStore, DeviceTypesStore } from '@/stores/device-manager/';
import { DeviceSettingsEditor } from '@/pages/settings/device-manager/components/device-settings-editor/device-settings-editor';
import type { Device, DeviceSettingsWasmProps } from './types';
import './styles.css';

export const DeviceSettingsWasm = observer(({
  scan,
  isReady,
  loadConfig,
  portScan,
  selectPort,
  getSchema,
  getDeviceTypes,
  save,
}: DeviceSettingsWasmProps) => {
  const { t } = useTranslation();
  const [language, setLanguage] = useState(localStorage.getItem('language') || 'en');
  const [devices, setDevices] = useState<Device[]>([]);
  const [tabstore, setTabstore] = useState(null);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [isConfigLoading, setIsConfigLoading] = useState(false);
  const [configDeviceTypesStore, setConfigDeviceTypesStore] = useState(null);
  const { activeTab } = useTabs({
    defaultTab: selectedDevice,
    items: devices,
  });

  const reset = () => {
    setDevices([]);
    setTabstore(null);
  };

  const configDeviceTypes = async () => {
    return getDeviceTypes(language).then((res) => {
      const deviceTypesStore = new DeviceTypesStore(getSchema);
      deviceTypesStore.setDeviceTypeGroups(res);
      setConfigDeviceTypesStore(deviceTypesStore);
      return deviceTypesStore;
    });
  };

  useEffect(() => {
    setReactLocale();
  }, []);

  useEffect(() => {
    isReady.then(async () => {
      const store = await configDeviceTypes();
      if (selectedDevice) {
        loadDeviceSettings(getDevice(), store);
      }
    });
  }, [isReady, language]);

  const handleScan = async () => {
    reset();
    const res = await scan();
    const firstDevice = res.at(0);
    setSelectedDevice(firstDevice?.cfg.slave_id);

    setDevices(res);

    loadDeviceSettings(firstDevice, configDeviceTypesStore);
  };

  const loadDeviceSettings = useCallback(async (device: Device, deviceTypesStore = configDeviceTypesStore) => {
    const deviceTypes = deviceTypesStore.findNotDeprecatedDeviceTypes(
      device.device_signature,
      device.fw?.version
    );

    setIsConfigLoading(true);

    const initialData = { slave_id: String(device.cfg.slave_id) };
    const cfg = { device_type: deviceTypes.at(0), ...device.cfg };
    const store = new DeviceTabStore(
      initialData,
      deviceTypes.at(0),
      deviceTypesStore,
      { GetFirmwareInfo: () => ({ fw: device.fw?.version }), hasMethod: () => true },
      { LoadConfig: () => loadConfig(cfg).then(res => res.result) }
    );
    await store.loadContent(device.cfg);
    store.setDeviceType(device.device_signature, cfg);
    await store.updateEmbeddedSoftwareVersion(device.cfg);

    setTabstore(store);
    setIsConfigLoading(false);
  }, [configDeviceTypesStore]);

  const getDevice = (slaveId: number = selectedDevice) => devices.find((device) => device.cfg.slave_id === slaveId);

  const handleSave = () => {
    const data = {
      device_type: tabstore.deviceType,
      ...getDevice().cfg,
      parameters: tabstore.editedData,
    };
    delete data.parameters.slave_id;

    save(data);
  };

  return (
    <PageLayout
      title={t('wasm.title')}
      actions={
        <>
          <Button label={t('wasm.buttons.select')} variant="secondary" onClick={selectPort} />
          <Button label={t('wasm.buttons.scan')} onClick={handleScan} />
          <Button label={t('wasm.buttons.save')} disabled={!devices.length} variant="success" onClick={handleSave} />
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
      {portScan.progress !== 0 && portScan.progress < 100 && (
        <Progress value={portScan.progress} caption={portScan.progress.toFixed() + '%'} />
      )}
      <main className="deviceSettingsWasm-container">
        <aside className="deviceSettingsWasm-aside">
          {!!devices.length && (
            <Tabs
              items={devices.map((device) => ({ id: device.cfg.slave_id, label: `${device.cfg.slave_id} ${configDeviceTypesStore.findNotDeprecatedDeviceTypes(device.device_signature, device.fw?.version).at(0)}` }))}
              activeTab={activeTab}
              onTabChange={(id: number) => {
                const device = getDevice(id);
                setSelectedDevice(id);
                loadDeviceSettings(device);
              }}
            />
          )}

        </aside>
        <section className="deviceSettingsWasm-content">
          {isConfigLoading ? (
            <div className="deviceSettingsWasm-loaderWrapper"><Loader caption={t('device-manager.labels.reading-parameters')} /></div>
          ) : (
            tabstore && (
              <>
                <h3 className="deviceSettingsWasm-title">{tabstore.name}</h3>
                <FirmwareVersionPanel firmwareVersion={getDevice().fw?.version} />
                <DeviceSettingsEditor
                  store={tabstore.schemaStore}
                  translator={tabstore.schemaStore.schemaTranslator}
                  showChannels={false}
                />
              </>
            )
          )}
        </section>
      </main>
    </PageLayout>
  );
});
