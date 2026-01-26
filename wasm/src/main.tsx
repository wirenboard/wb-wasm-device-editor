import { configure } from 'mobx';
import { createRoot } from 'react-dom/client';
import { DeviceSettingsWasm } from './device-settings-wasm';
import { configI18n } from './i18n/config';
import '@/assets/styles/animations.css';
import '@/assets/styles/variables.css';
import '~styles/main.css';
import '~styles/css/bootstrap.min.css';
import '~styles/css/new.css';
import '~styles/css/device-manager.css';

configure({
  enforceActions: 'never',
});

configI18n();

createRoot(document.querySelector('#root')).render(<DeviceSettingsWasm />);
