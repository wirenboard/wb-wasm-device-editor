import i18n from '@/i18n/config';
import engModuleLocale from './en/translations.json';
import ruModuleLocale from './ru/translations.json';

/**
 * Add this editor's own strings to homeui's i18n.
 *
 * homeui configures the i18next singleton itself now — importing `@/i18n/config`
 * is what initialises it, locales included — so this contributes the keys the
 * standalone editor adds rather than initialising it a second time.
 */
export const configI18n = () => {
  i18n.addResourceBundle('en', 'translations', engModuleLocale, true, true);
  i18n.addResourceBundle('ru', 'translations', ruModuleLocale, true, true);
};

export const setLanguage = (language: string) => {
  i18n.changeLanguage(language);
};

export default i18n;
