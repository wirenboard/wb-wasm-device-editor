import i18n from '@/i18n/config';
import engModuleLocale from './en/translations.json';
import ruModuleLocale from './ru/translations.json';

export const configI18n = () => {
  i18n.addResourceBundle('en', 'translations', engModuleLocale, true, true);
  i18n.addResourceBundle('ru', 'translations', ruModuleLocale, true, true);

  const lang = localStorage.getItem('language') || 'en';
  if (i18n.language !== lang) {
    i18n.changeLanguage(lang);
  }
};
