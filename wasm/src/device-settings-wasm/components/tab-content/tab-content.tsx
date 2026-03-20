import { observer } from 'mobx-react-lite';
import { useTranslation } from 'react-i18next';
import {
  MakeEditors,
} from '@/pages/settings/device-manager/components/device-settings-editor/device-settings-param-editor';
import { type WbDeviceParameterEditorsGroup } from '@/stores/device-manager';
import type { Translator } from '@/stores/json-schema-editor';
import { SubGroupContent } from '../sub-group-content';

export const SettingsTabContent = observer((
  { group, translator }: { group: WbDeviceParameterEditorsGroup; translator: Translator },
) => {
  const { i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const showDescription = !!group.properties.description;
  return (
    <div className="deviceSettingsEditor-topGroupContent">
      {showDescription && (
        <p className="wb-jsonEditor-propertyDescription">
          {translator.find(group.properties.description, currentLanguage)}
        </p>
      )}
      {MakeEditors(group.parameters, translator)}
      {group.subgroups.map((sub) => (
        sub.isEnabledByCondition
          ? <SubGroupContent key={sub.properties.id} group={sub} translator={translator} />
          : null
      ))}
    </div>
  );
});
