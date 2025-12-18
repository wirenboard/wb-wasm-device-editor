import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/button';
import { Loader } from '@/components/loader';
import { Progress } from '@/components/progress';
import { Tabs, useTabs } from '@/components/tabs';
import { PageLayout } from '@/layouts/page';
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
  const [devices, setDevices] = useState<Device[]>([]);
  const [tabstore, setTabstore] = useState(null);
  const [title, setTitle] = useState('');
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [isConfigLoading, setIsConfigLoading] = useState(false);
  const [configDeviceTypes, setConfigDeviceTypes] = useState(null);
  const { activeTab } = useTabs({
    defaultTab: selectedDevice,
    items: devices,
  });

  const reset = () => {
    setDevices([]);
    setTabstore(null);
    setTitle('');
  };

  useEffect(() => {
    isReady.then(() => {
      getDeviceTypes().then((res) => {
        setConfigDeviceTypes(res);
      });
    });
  }, [isReady]);

  const handleScan = async () => {
    reset();
    const res = await scan();
    const firstDevice = res.at(0);
    setSelectedDevice(firstDevice?.cfg.slave_id);
    setDevices(res);
    loadDeviceSettings(firstDevice);
  };

  const loadDeviceSettings = useCallback(async (device: Device) => {
    const deviceTypesStore = new DeviceTypesStore(getSchema);
    deviceTypesStore.setDeviceTypeGroups(configDeviceTypes);
    const deviceTypes = deviceTypesStore.findNotDeprecatedDeviceTypes(
      device.device_signature,
      device.fw?.version
    );
    setIsConfigLoading(true);
    setTitle(deviceTypesStore.getName(device.device_signature));

    const data = await loadConfig({ device_type: deviceTypes.at(0), ...device.cfg });
    const initialData = {
      slave_id: String(device.cfg.slave_id),
      ...data.result.parameters,
    };
    const store = new DeviceTabStore(initialData, deviceTypes.at(0), deviceTypesStore);
    await store.loadContent(device.cfg);
    store.setDeviceType(device.device_signature, { device_type: deviceTypes.at(0), ...device.cfg });

    setTabstore(store);
    setIsConfigLoading(false);
  }, [configDeviceTypes]);

  const handleSave = () => {
    const device = devices.find((device) => device.cfg.slave_id === selectedDevice)
    const data = {
      device_type: tabstore.deviceType,
      ...device.cfg,
      parameters: tabstore.editedData,
    };
    delete data.parameters.slave_id;

    save(data);
  };

  return (
    <PageLayout
      title="Web Serial"
      actions={
        <>
          <Button label="Select port" variant="secondary" onClick={selectPort} />
          <Button label="Scan" onClick={handleScan} />
          <Button label="Save" disabled={!devices.length} variant="success" onClick={handleSave} />
        </>
      }
      isLoading={!configDeviceTypes}
      hasRights
    >
      {portScan.progress !== 0 && portScan.progress < 100 && (
        <Progress value={portScan.progress} caption={portScan.progress.toFixed() + '%'} />
      )}
      <main className="deviceSettingsWasm-container">
        <aside className="deviceSettingsWasm-aside">
          {!!devices.length && (
            <Tabs
              items={devices.map((device) => ({ id: device.cfg.slave_id, label: `${device.cfg.slave_id} ${device.device_signature}` }))}
              activeTab={activeTab}
              onTabChange={(id: number) => {
                const device = devices.find((item: Device) => item.cfg.slave_id === id);
                setSelectedDevice(id);
                loadDeviceSettings(device);
              }}
            />
          )}

        </aside>
        <section className="deviceSettingsWasm-content">
          {isConfigLoading ? (
            <div className="deviceSettingsWasm-loaderWrapper"><Loader /></div>
          ) : (
            tabstore && (
              <>
                {title && <h3 className="deviceSettingsWasm-title">{title}</h3>}
                <DeviceSettingsEditor store={tabstore.schemaStore} translator={tabstore.schemaStore.schemaTranslator} />
              </>
            )
          )}
        </section>
      </main>
    </PageLayout>
  );
});
