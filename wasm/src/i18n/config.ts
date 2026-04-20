import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import engLocale from '~/i18n/react/locales/en/translations.json';
import ruLocale from '~/i18n/react/locales/ru/translations.json';
import engModuleLocale from './en/translations.json';
import ruModuleLocale from './ru/translations.json';

export const configI18n = () => {
  i18n.use(initReactI18next).init({
    fallbackLng: 'en',
    lng: 'en',
    resources: {
      en: {
        translations: { ...engLocale, ...engModuleLocale },
      },
      ru: {
        translations: { ...ruLocale, ...ruModuleLocale },
      },
    },
    ns: ['translations'],
    defaultNS: 'translations',
    interpolation: {
      escapeValue: false,
    },
    react: {
      transSupportBasicHtmlNodes: true,
    },
  });

  i18n.languages = ['en', 'ru'];
};
