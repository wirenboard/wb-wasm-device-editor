import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/button';
import { Cell as CellContent } from '@/components/cell';
import { Switch } from '@/components/switch';
import Cell from '@/stores/devices/cell';
import type { CellType } from '@/stores/devices/cell-type';
import type { RuntimeViewProps, TemplateChannel } from './types';
import './styles.css';

const POLL_INTERVAL = 2000;

function translateName(name: string, translations: Record<string, Record<string, string>>, lang: string): string {
  return translations?.[lang]?.[name] || translations?.en?.[name] || name;
}

function applyReadonly(cells: Cell[], readonlyList: string[]) {
  if (!Array.isArray(readonlyList) || readonlyList.length === 0) return;
  const readonlySet = new Set(readonlyList);
  cells.forEach((cell) => {
    cell.setReadOnly(readonlySet.has(cell.controlId));
  });
}

function cleanStringValue(value: string): string {
  // Strip from the first control character (< 0x20) or DEL (0x7F).
  // Modbus string registers often contain garbage bytes after the real data.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return value.slice(0, i);
  }
  return value;
}

function createCells(
  channels: TemplateChannel[],
  translations: Record<string, Record<string, string>>,
  lang: string,
  onWrite: (channelName: string, value: string) => void,
): Cell[] {
  return channels.map((ch) => {
    const cell = new Cell(`device/${ch.name}`, async (_deviceId, _controlId, value) => {
      onWrite(ch.name, value);
    });

    const cellType = (ch.type || 'value') as CellType;
    cell.setType(cellType);
    cell.setReadOnly(ch.readonly ?? null);
    cell.setName(translateName(ch.name, translations, lang));

    if (ch.units) {
      cell.setUnits(ch.units);
    }
    if (ch.min !== undefined) {
      cell.setMin(ch.min);
    }
    if (ch.max !== undefined) {
      cell.setMax(ch.max);
    }
    if (Array.isArray(ch.enum) && Array.isArray(ch.enum_titles)) {
      const enumObj: Record<string, Record<string, string>> = {};
      ch.enum.forEach((val: number | string, i: number) => {
        const title = ch.enum_titles![i] || String(val);
        const entry: Record<string, string> = { en: title };
        for (const [lang, dict] of Object.entries(translations)) {
          if (lang !== 'en' && dict[title]) {
            entry[lang] = dict[title];
          }
        }
        enumObj[String(val)] = entry;
      });
      cell.setMeta(JSON.stringify({ enum: enumObj }));
    }

    return cell;
  });
}

export const RuntimeView = observer(({
  deviceCfg,
  deviceLoad,
  save,
  configGetSchema,
}: RuntimeViewProps) => {
  const { t, i18n } = useTranslation();
  const [cells, setCells] = useState<Cell[]>([]);
  const [channelNames, setChannelNames] = useState<string[]>([]);
  const [unsupportedNames, setUnsupportedNames] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(() => localStorage.getItem('runtimeViewAutoRefresh') === 'true');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingRef = useRef(false);
  const cellsRef = useRef<Cell[]>([]);
  const channelNamesRef = useRef<string[]>([]);
  const autoRefreshRef = useRef(autoRefresh);
  const writingRef = useRef(false);
  const deviceCfgRef = useRef(deviceCfg);

  useEffect(() => {
    autoRefreshRef.current = autoRefresh;
    localStorage.setItem('runtimeViewAutoRefresh', String(autoRefresh));
  }, [autoRefresh]);

  useEffect(() => {
    deviceCfgRef.current = deviceCfg;
  }, [deviceCfg]);

  const pollValues = useCallback(async () => {
    const names = channelNamesRef.current;
    const currentCells = cellsRef.current;
    if (!names.length || !currentCells.length) return;

    const cfg = deviceCfgRef.current;
    try {
      const result = await deviceLoad({
        slave_id: cfg.slave_id,
        device_type: cfg.device_type,
        baud_rate: cfg.baud_rate,
        parity: cfg.parity,
        data_bits: cfg.data_bits,
        stop_bits: cfg.stop_bits,
        channels: names,
      });

      if (writingRef.current) return;

      if (result.error) {
        setError(result.error.message);
        return;
      }

      setError(null);
      const channelValues = result.result?.channels || {};
      const readonlyList: string[] = result.result?.readonly || [];
      applyReadonly(currentCells, readonlyList);
      const unsupported = new Set<string>();
      currentCells.forEach((cell) => {
        const name = cell.controlId;
        if (!(name in channelValues)) return;
        if (channelValues[name] !== 'unsupported') {
          cell.receiveValue(cleanStringValue(String(channelValues[name])));
        } else {
          unsupported.add(name);
        }
      });
      setUnsupportedNames(unsupported);
    } catch (e: any) {
      setError(e.message || 'Failed to load channel values');
    }
  }, [deviceLoad]);

  const handleWrite = useCallback(async (channelName: string, value: string) => {
    writingRef.current = true;
    try {
      const cfg = deviceCfgRef.current;
      const data = {
        device_type: cfg.device_type,
        slave_id: cfg.slave_id,
        baud_rate: cfg.baud_rate,
        parity: cfg.parity,
        data_bits: cfg.data_bits,
        stop_bits: cfg.stop_bits,
        channels: { [channelName]: value },
      };
      const result = await save(data);
      if (result?.error) {
        setError(result.error.message);
        return;
      }
    } finally {
      writingRef.current = false;
    }
    await pollValues();
  }, [save, pollValues]);

  // Initialize cells from schema when deviceCfg changes
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      setIsLoading(true);
      setError(null);
      setCells([]);
      setChannelNames([]);

      try {
        const schema = await configGetSchema(deviceCfg.device_type);
        if (cancelled) return;

        const device = (schema as any)?.device;
        // Templates mark internal machinery — the DALI send queue, reply
        // registers, the monitor ring — as hidden; wb-mqtt-serial keeps them
        // off homeui's device pages, and raw 64-bit ring values sitting next
        // to a temperature read as noise at best and as faults at worst.
        const channels: TemplateChannel[] = (device?.channels || [])
          .filter((ch: TemplateChannel & { hidden?: boolean }) => !ch.hidden);
        const translations = device?.translations || {};

        // Initial poll — no channel list, C++ reads all supported channels
        const cfg = deviceCfg;
        try {
          const result = await deviceLoad({
            slave_id: cfg.slave_id,
            device_type: cfg.device_type,
            baud_rate: cfg.baud_rate,
            parity: cfg.parity,
            data_bits: cfg.data_bits,
            stop_bits: cfg.stop_bits,
          });
          if (cancelled) return;
          if (result.error) {
            setError(result.error.message);
            return;
          }

          const channelValues = result.result?.channels || {};
          const readonlyList: string[] = result.result?.readonly || [];

          // Build channel list from C++ response + schema metadata.
          // Templates may define duplicate channel names with different conditions
          // (e.g. WB-MR6C v.3 has two "K1" entries for normal/curtain modes).
          // C++ returns one value per name, so keep only the first matching entry.
          const seen = new Set<string>();
          const returnedChannels = channels
            .filter((ch) => ch.name in channelValues && !seen.has(ch.name) && seen.add(ch.name));

          const names = returnedChannels.map((ch) => ch.name);
          const newCells = createCells(returnedChannels, translations, i18n.language, handleWrite);
          applyReadonly(newCells, readonlyList);
          const unsupported = new Set<string>();
          newCells.forEach((cell) => {
            const val = channelValues[cell.controlId];
            if (val !== 'unsupported') {
              cell.receiveValue(cleanStringValue(String(val)));
            } else {
              unsupported.add(cell.controlId);
            }
          });

          cellsRef.current = newCells;
          channelNamesRef.current = names;
          setCells(newCells);
          setChannelNames(names);
          setUnsupportedNames(unsupported);
        } catch (e: any) {
          if (!cancelled) setError(e.message || 'Failed to load channel values');
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Failed to load schema');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    init();
    return () => {
      cancelled = true;
    };
  }, [deviceCfg.device_type, deviceCfg.slave_id]);

  // Polling timer — pauses when page/tab is hidden
  useEffect(() => {
    if (!channelNames.length) return;

    pollTimerRef.current = setInterval(async () => {
      if (pollingRef.current) return;
      if (autoRefreshRef.current && document.visibilityState === 'visible') {
        pollingRef.current = true;
        try {
          await pollValues();
        } finally {
          pollingRef.current = false;
        }
      }
    }, POLL_INTERVAL);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [channelNames, pollValues]);

  const handleRefresh = useCallback(() => {
    pollValues();
  }, [pollValues]);

  if (isLoading) return null;

  return (
    <div className="runtimeView">
      <div className="runtimeView-controls">
        <label className="runtimeView-autoRefresh">
          <Switch value={autoRefresh} onChange={setAutoRefresh} />
          <span>{t('wasm.labels.auto-refresh')}</span>
        </label>
        <Button
          label={t('wasm.buttons.refresh')}
          variant="secondary"
          size="small"
          disabled={autoRefresh}
          onClick={handleRefresh}
        />
      </div>
      {error && (
        <div className="runtimeView-error">{error}</div>
      )}
      <div className="deviceSettingsEditor-topGroupContent">
        {cells.map((cell) => (
          <div key={cell.id} className="deviceSettingsEditor-parameter">
            {unsupportedNames.has(cell.controlId) ? (
              <div className="deviceCell deviceCell-error">
                <div className="deviceCell-name">{cell.name}</div>
                <span>-</span>
              </div>
            ) : cell.type === 'switch' && cell.readOnly ? (
              // A read-only boolean drawn as a toggle invites clicking and
              // reads as a *setting* ("Overheat: ON" looks like a switched-on
              // feature, not a fault flag). A labeled status is unambiguous.
              <div className="deviceCell">
                <div className="deviceCell-name">{cell.name}</div>
                <span
                  className={classNames('runtimeView-status', {
                    'runtimeView-statusActive': !!cell.value,
                  })}
                >
                  {cell.value ? t('wasm.labels.status-yes') : t('wasm.labels.status-no')}
                </span>
              </div>
            ) : (
              <CellContent
                cell={cell}
                hideHistory={true}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
});
