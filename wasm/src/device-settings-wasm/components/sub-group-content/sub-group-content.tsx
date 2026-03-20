import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { useTranslation } from 'react-i18next';
import {
  MakeEditors,
} from '@/pages/settings/device-manager/components/device-settings-editor/device-settings-param-editor';
import { type WbDeviceParameterEditorsGroup } from '@/stores/device-manager';
import type { Translator } from '@/stores/json-schema-editor';

export const SubGroupContent = observer((
  { group, translator }: { group: WbDeviceParameterEditorsGroup; translator: Translator },
) => {
  const { i18n } = useTranslation();
  const currentLanguage = i18n.language;
  return (
    <div className="deviceSettingsEditor-subGroup">
      {!group.properties.ui_options?.wb?.disable_title && (
        <label>{translator.find(group.properties.title, currentLanguage)}</label>
      )}
      <div
        className={classNames({
          'deviceSettingsEditor-subGroupContent': true,
          'deviceSettingsEditor-subGroupContentWithBorder': !group.properties.ui_options?.wb?.disable_title,
        })}
      >
        {MakeEditors(group.parameters, translator)}
        {group.subgroups.map((sub) => (
          sub.isEnabledByCondition
            ? <SubGroupContent key={sub.properties.id} group={sub} translator={translator} />
            : null
        ))}
      </div>
    </div>
  );
});
