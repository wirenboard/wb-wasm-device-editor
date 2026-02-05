import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Confirm } from '@/components/confirm';
import { Dropdown, type Option } from '@/components/dropdown';
import { Input } from '@/components/input';
import type { AddDeviceProps, DeviceSettings } from './types';
import './styles.css';

export const AddDevice = ({ isOpened, deviceTypes, onSave, onClose }: AddDeviceProps) => {
  const { t } = useTranslation();

  const [device, setDevice] = useState();
  const [cfg, setCfg] = useState<DeviceSettings>({
    slave_id: 1,
    baud_rate: 9600,
    data_bits: 8,
    parity: 'N',
    stop_bits: 2,
  });
  const baudrateOptions = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
  const parityOptions = [
    { value: 'N', label: t('wasm.labels.parity-never') },
    { value: 'E', label: t('wasm.labels.parity-even') },
    { value: 'O', label: t('wasm.labels.parity-odd') },
  ];
  const databitsOptions = [5, 6, 7, 8];
  const stopOptions = [1, 2];

  return (
    <Confirm
      isOpened={isOpened}
      heading={t('wasm.buttons.add-device')}
      acceptLabel={t('wasm.buttons.add')}
      closeCallback={onClose}
      confirmCallback={() => onSave({ device_signature: device, cfg })}
    >
      <label className="addDevice-label">
        {t('wasm.labels.device-type')}
        <Dropdown
          id="device-type"
          options={deviceTypes}
          value={device}
          isSearchable
          onChange={({ value }: Option<string>) => setDevice(value)}
        />
      </label>

      <label className="addDevice-label">
        {t('wasm.labels.slave-id')}
        <Input
          value={cfg.slave_id}
          type="number"
          min={1}
          max={247}
          onChange={(value: number) => setCfg({ ...cfg, slave_id: value })}
        />
      </label>

      <label className="addDevice-label">
        {t('wasm.labels.baudrate')}
        <Dropdown
          id="baudrate-type"
          options={baudrateOptions.map((item) => ({ label: item, value: item }))}
          value={cfg.baud_rate}
          onChange={({ value }: Option<number>) => {
            setCfg({ ...cfg, baud_rate: value });
          }}
        />
      </label>

      <label className="addDevice-label">
        {t('wasm.labels.parity')}
        <Dropdown
          id="parity"
          options={parityOptions}
          value={cfg.parity}
          onChange={({ value }: Option<string>) => {
            setCfg({ ...cfg, parity: value });
          }}
        />
      </label>

      <label className="addDevice-label">
        {t('wasm.labels.databits')}
        <Dropdown
          id="data_bits"
          options={databitsOptions.map((item) => ({ label: item, value: item }))}
          value={cfg.data_bits}
          onChange={({ value }: Option<string>) => {
            setCfg({ ...cfg, data_bits: value });
          }}
        />
      </label>

      <label className="addDevice-label">
        {t('wasm.labels.stopbits')}
        <Dropdown
          id="data_bits"
          options={stopOptions.map((item) => ({ label: item, value: item }))}
          value={cfg.stop_bits}
          onChange={({ value }: Option<string>) => {
            setCfg({ ...cfg, stop_bits: value });
          }}
        />
      </label>
    </Confirm>
  );
};
