import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/alert';
import { Button } from '@/components/button';
import { JsonSchemaEditor } from '@/components/json-schema-editor';
import { Tabs, TabContent, useTabs } from '@/components/tabs';
import { EmbeddedSoftwarePanel } from '@/pages/settings/device-manager';
import {
  MakeEditors,
} from '@/pages/settings/device-manager/components/device-settings-editor/device-settings-param-editor';
import type { WbDeviceParameterEditorsGroup } from '@/stores/device-manager';
import { RuntimeView } from '../runtime-view';
import { SettingsTabContent } from '../tab-content';

const RUNTIME_VIEW_TAB_ID = 'runtime-view';
const EMPTY_GROUPS: WbDeviceParameterEditorsGroup[] = [];

interface DeviceSettingsViewProps {
  tabstore: any;
  isBusy: boolean;
  isLocal: boolean;
  deviceFwVersion: string | null;
  saveCounter: number;
  deviceCfg: any;
  deviceLoad: any;
  save: any;
  configGetSchema: any;
  onSaveLocal: () => void;
  onRemoveLocal: () => void;
  onUpdateFirmware: () => void;
  onUpdateBootloader: () => void;
  onUpdateComponents: () => void;
}

export const DeviceSettingsView = observer(({
  tabstore,
  isBusy,
  isLocal,
  deviceFwVersion,
  saveCounter,
  deviceCfg,
  deviceLoad,
  save,
  configGetSchema,
  onSaveLocal,
  onRemoveLocal,
  onUpdateFirmware,
  onUpdateBootloader,
  onUpdateComponents,
}: DeviceSettingsViewProps) => {
  const { t, i18n } = useTranslation();

  const schemaStore = tabstore?.schemaStore;
  const translator = schemaStore?.schemaTranslator;
  const settingsGroups: WbDeviceParameterEditorsGroup[] = schemaStore?.topLevelGroup?.subgroups || EMPTY_GROUPS;

  const settingsTabs = useMemo(() => {
    if (!settingsGroups.length) return [];
    return settingsGroups
      .filter((group) => !!(group.parameters.length + group.subgroups.length))
      .map((group) => ({
        id: group.properties.id,
        label: (
          <span
            className={classNames({
              'deviceSettingsEditor-tabWithError': group.hasErrors,
              'deviceSettingsEditor-tabWithWarning': group.hasBadValuesFromRegisters && !group.hasErrors,
            })}
          >
            {translator?.find(group.properties.title, i18n.language) ?? group.properties.title}
          </span>
        ),
      }));
  }, [settingsGroups, translator, i18n.language]);

  const allTabs = useMemo(() => [
    ...settingsTabs,
    { id: RUNTIME_VIEW_TAB_ID, label: t('wasm.labels.runtime-view') },
  ], [settingsTabs, t]);

  const {
    activeTab: activeSettingsTab,
    onTabChange: onSettingsTabChange,
  } = useTabs({
    defaultTab: settingsTabs[0]?.id,
    items: allTabs,
  });

  if (!tabstore || !schemaStore || !translator) return null;

  return (
    <>
      <header className="deviceSettingsWasm-header">
        <h3 className="deviceSettingsWasm-title">{tabstore.name}</h3>
        {isLocal
          ? (
            <Button
              label={t('wasm.buttons.remove-local')}
              variant="secondary"
              size="small"
              disabled={isBusy}
              onClick={onRemoveLocal}
            />
          )
          : (
            <Button
              label={t('wasm.buttons.save-local')}
              variant="secondary"
              size="small"
              disabled={isBusy}
              onClick={onSaveLocal}
            />
          )
        }
      </header>
      <EmbeddedSoftwarePanel
        embeddedSoftware={tabstore.embeddedSoftware}
        onUpdateFirmware={onUpdateFirmware}
        onUpdateBootloader={onUpdateBootloader}
        onUpdateComponents={onUpdateComponents}
      />
      {!tabstore.embeddedSoftware.firmware.current && deviceFwVersion && (
        <div className="firmwareVersionPanel">
          <b>{t('device-manager.labels.current-firmware', { firmware: deviceFwVersion })}</b>
        </div>
      )}
      {tabstore.slaveIdIsDuplicate && (
        <Alert
          className="deviceSettingsWasm-alert"
          variant="danger"
        >
          {t('device-manager.errors.duplicate-slave-id')}
        </Alert>
      )}
      <div className={classNames('deviceSettingsEditor', 'deviceSettingsEditor-desktop', { 'deviceSettingsWasm-aside--disabled': isBusy })}>
        <JsonSchemaEditor store={schemaStore.commonParams} translator={translator} />
        {MakeEditors(schemaStore.topLevelGroup.parameters, translator)}
        {allTabs.length > 0 && (
          <div className="deviceSettingsEditor-tabs">
            <Tabs
              activeTab={activeSettingsTab}
              items={allTabs}
              onTabChange={onSettingsTabChange}
            />
            {settingsGroups
              .filter((group) => !!(group.parameters.length + group.subgroups.length))
              .map((group) => (
                <TabContent
                  key={group.properties.id}
                  activeTab={activeSettingsTab}
                  tabId={group.properties.id}
                  className="deviceSettingsEditor-tabContent"
                >
                  <SettingsTabContent group={group} translator={translator} />
                </TabContent>
              ))
            }
            <TabContent
              activeTab={activeSettingsTab}
              tabId={RUNTIME_VIEW_TAB_ID}
              className="deviceSettingsEditor-tabContent"
            >
              <RuntimeView
                key={saveCounter}
                deviceCfg={deviceCfg}
                deviceLoad={deviceLoad}
                save={save}
                configGetSchema={configGetSchema}
              />
            </TabContent>
          </div>
        )}
      </div>
    </>
  );
});
