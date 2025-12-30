import i18n from 'i18next';
import { configure, makeObservable, observable } from 'mobx';
import { createRoot } from 'react-dom/client';
import { initReactI18next } from 'react-i18next';
import { DeviceSettingsWasm } from './device-settings-wasm';
import type { Device } from './device-settings-wasm/types';
import engLocale from '~/i18n/react/locales/en/translations.json';
import engModuleLocale from './i18n/en/translations.json';
import ruModuleLocale from './i18n/ru/translations.json';
import ruLocale from '~/i18n/react/locales/ru/translations.json';
import '@/assets/styles/variables.css';
import '@/assets/styles/animations.css';
import '~styles/main.css';
import '~styles/css/bootstrap.min.css';
import '~styles/css/new.css';
import '~styles/css/device-manager.css';

configure({
  enforceActions: 'never',
});

i18n.use(initReactI18next).init({
  fallbackLng: 'en',
  lng: 'en',
  resources: {
    en: {
      translations: {...engLocale, ...engModuleLocale},
    },
    ru: {
      translations: {...ruLocale, ...ruModuleLocale},
    },
  },
  ns: ['translations'],
  defaultNS: 'translations',
  react: {
    transSupportBasicHtmlNodes: true,
  },
});

i18n.languages = ['en', 'ru'];

declare class PortScan {
  exec(): Promise<{ devices: any[] }>;
  progress: number;
}

declare const Module: {
  request: (method: string, params: any) => Promise<any>;
  serial: {
    select: (auto: boolean) => Promise<any>;
  };
  isReady: Promise<void>
};
const portScan = new PortScan();

makeObservable(portScan, {
  progress: observable,
});

const selectPort = async () => {
  return Module.serial.select(true);
};

const scan = async (): Promise<Device[]> => {
  return portScan.exec().then(({ devices }) => devices);
};

const loadConfig = async (cfg) => {
  return Module.request('deviceLoadConfig', cfg);
};

const configGetDeviceTypes = async (lang: string) => {
  return Module.request('configGetDeviceTypes', { lang }).then((res) => res.result);
};

const configGetSchema = async (deviceType: string) => {
  return Module.request('configGetSchema', { type: deviceType }).then((res) => res.result);
};

const save = async (data: any) => {
  return Module.request('deviceSet', data);
};

createRoot(document.querySelector('#root')).render(
  <DeviceSettingsWasm
    isReady={Module.isReady}
    scan={scan}
    save={save}
    portScan={portScan}
    selectPort={selectPort}
    loadConfig={loadConfig}
    getSchema={configGetSchema}
    getDeviceTypes={configGetDeviceTypes}
  />
);
