import { type Option } from '@/components/dropdown';
import type { Device } from '../../types';

export type DeviceSettings = Device['cfg'];

interface SaveSettings {
  device_signature: string; cfg: Device['cfg'];
}

export interface AddDeviceProps {
  isOpened: boolean;
  deviceTypes: Option<string>[];
  onSave: (device: SaveSettings) => void;
  onClose: () => void;
}
