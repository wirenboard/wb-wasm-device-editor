import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/button';
import { CellContent } from '@/components/cell/cell';
import { Switch } from '@/components/switch';
import Cell from '@/stores/device/cell';
import type { CellType } from '@/stores/device/cell-type';
import '@/components/cell/styles.css';
import './runtime-view.css';

interface TemplateChannel {
  name: string;
  type?: string;
  readonly?: boolean;
  units?: string;
  min?: number;
  max?: number;
  scale?: number;
  enum?: Record<string, string>;
  enum_titles?: Record<string, string>;
  address?: number;
  reg_type?: string;
  enabled?: boolean;
  condition?: string;
  fw?: string;
}

interface RuntimeViewProps {
  deviceCfg: {
    slave_id: number;
    device_type: string;
    baud_rate: number;
    parity: string;
    data_bits: number;
    stop_bits: number;
  };
  deviceLoad: (data: any) => Promise<any>;
  save: (data: any) => Promise<any>;
  configGetSchema: (deviceType: string) => Promise<any>;
  fwVersion?: string;
}

const POLL_INTERVAL = 2000;

function translateName(name: string, translations: Record<string, Record<string, string>>, lang: string): string {
  return translations?.[lang]?.[name] || translations?.en?.[name] || name;
}

function applyReadonly(cells: Cell[], readonlyMap: Record<string, boolean>) {
  cells.forEach((cell) => {
    if (readonlyMap[cell.controlId]) {
      cell.setReadOnly(true);
    }
  });
}

function cleanStringValue(value: string): string {
  // Strip from the first control character (< 0x20) or DEL (0x7F).
  // Modbus string registers often contain garbage bytes after the real data.
  const idx = [...value].findIndex((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  return idx >= 0 ? value.slice(0, idx) : value;
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

    return cell;
  });
}

export const RuntimeView = observer(({
  deviceCfg,
  deviceLoad,
  save,
  configGetSchema,
  fwVersion,
}: RuntimeViewProps) => {
  const { t, i18n } = useTranslation();
  const [cells, setCells] = useState<Cell[]>([]);
  const [channelNames, setChannelNames] = useState<string[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cellsRef = useRef<Cell[]>([]);
  const channelNamesRef = useRef<string[]>([]);
  const autoRefreshRef = useRef(true);
  const deviceCfgRef = useRef(deviceCfg);
  const fwVersionRef = useRef(fwVersion);

  useEffect(() => {
    autoRefreshRef.current = autoRefresh;
  }, [autoRefresh]);

  useEffect(() => {
    fwVersionRef.current = fwVersion;
  }, [fwVersion]);

  useEffect(() => {
    deviceCfgRef.current = deviceCfg;
  }, [deviceCfg]);

  const handleWrite = useCallback(async (channelName: string, value: string) => {
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
    await save(data);
    await pollValues();
  }, [save]);

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
        fw_version: fwVersionRef.current,
        channels: names,
      });

      if (result.error) {
        setError(result.error.message);
        return;
      }

      setError(null);
      const channelValues = result.result?.channels || {};
      const readonlyMap = result.result?.readonly || {};
      applyReadonly(currentCells, readonlyMap);
      currentCells.forEach((cell) => {
        const name = cell.controlId;
        if (name in channelValues && channelValues[name] !== 'unsupported') {
          cell.receiveValue(cleanStringValue(String(channelValues[name])));
        }
      });
    } catch (e: any) {
      setError(e.message || 'Failed to load channel values');
    }
  }, [deviceLoad]);

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
        const channels: TemplateChannel[] = device?.channels || [];
        const translations = device?.translations || {};
        const channelsByName = new Map(channels.map((ch) => [ch.name, ch]));

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
            fw_version: fwVersion,
          });
          if (cancelled) return;
          if (result.error) {
            setError(result.error.message);
            return;
          }

          const channelValues = result.result?.channels || {};
          const readonlyMap = result.result?.readonly || {};

          // Build channel list from C++ response + schema metadata
          const returnedChannels = Object.keys(channelValues)
            .map((name) => channelsByName.get(name))
            .filter((ch): ch is TemplateChannel => !!ch);

          const names = returnedChannels.map((ch) => ch.name);
          const newCells = createCells(returnedChannels, translations, i18n.language, handleWrite);
          applyReadonly(newCells, readonlyMap);
          newCells.forEach((cell) => {
            const name = cell.controlId;
            if (channelValues[name] !== 'unsupported') {
              cell.receiveValue(cleanStringValue(String(channelValues[name])));
            }
          });

          cellsRef.current = newCells;
          channelNamesRef.current = names;
          setCells(newCells);
          setChannelNames(names);
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
    return () => { cancelled = true; };
  }, [deviceCfg.device_type, deviceCfg.slave_id]);

  // Polling timer
  useEffect(() => {
    if (!channelNames.length) return;

    pollTimerRef.current = setInterval(() => {
      if (autoRefreshRef.current) {
        pollValues();
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
        <div className="runtimeView-autoRefresh">
          <Switch value={autoRefresh} onChange={setAutoRefresh} />
          <span>{t('wasm.labels.auto-refresh')}</span>
        </div>
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
            <CellContent
              cell={cell}
              hideHistory={true}
            />
          </div>
        ))}
      </div>
    </div>
  );
});
