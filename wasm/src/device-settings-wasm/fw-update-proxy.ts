import type {
  FwUpdateProxy,
  FwUpdateProxyGetFirmwareInfoParams,
  FwUpdateProxyGetFirmwareInfoResult,
  FwUpdateProxyUpdateParams,
  FwUpdateProxyClearErrorParams,
  FwUpdateProxyRestoreParams,
} from '@/stores/device-manager/types';

export class WasmFwUpdateProxy implements FwUpdateProxy {
  private _isOffline: () => boolean;

  constructor(isOffline: () => boolean) {
    this._isOffline = isOffline;
  }

  private requireOnline() {
    if (this._isOffline()) {
      throw new Error('Firmware operations require an internet connection');
    }
  }

  async hasMethod(method: string): Promise<boolean> {
    return ['GetFirmwareInfo', 'Update', 'ClearError', 'Restore'].includes(method);
  }

  private portSettings(params: { port?: any }) {
    if (!params.port) return {};
    return {
      baud_rate: params.port.baud_rate ?? params.port.baudRate,
      data_bits: params.port.data_bits ?? params.port.dataBits,
      parity: params.port.parity,
      stop_bits: params.port.stop_bits ?? params.port.stopBits,
    };
  }

  async GetFirmwareInfo(
    params: FwUpdateProxyGetFirmwareInfoParams,
  ): Promise<FwUpdateProxyGetFirmwareInfoResult> {
    this.requireOnline();
    const res = await Module.request('fwGetInfo', {
      slave_id: params.slave_id,
      protocol: params.protocol || 'modbus',
      ...this.portSettings(params),
    });
    if (res.error) throw new Error(res.error.message);
    return res.result as FwUpdateProxyGetFirmwareInfoResult;
  }

  async Update(params: FwUpdateProxyUpdateParams): Promise<void> {
    this.requireOnline();
    const res = await Module.request('fwUpdate', {
      slave_id: params.slave_id,
      type: params.type || 'firmware',
      protocol: params.protocol || 'modbus',
      ...this.portSettings(params),
    });
    if (res.error) throw new Error(res.error.message);
  }

  async ClearError(params: FwUpdateProxyClearErrorParams): Promise<void> {
    const res = await Module.request('fwClearError', {
      slave_id: params.slave_id,
      type: params.type || 'firmware',
    });
    if (res.error) throw new Error(res.error.message);
  }

  async Restore(params: FwUpdateProxyRestoreParams): Promise<void> {
    this.requireOnline();
    const res = await Module.request('fwRestore', {
      slave_id: params.slave_id,
      protocol: params.protocol || 'modbus',
      ...this.portSettings(params),
    });
    if (res.error) throw new Error(res.error.message);
  }
}
