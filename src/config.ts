export const CHANNEL_IDS = {
  rpm: 1,
  iat: 4,
  clt: 24,
} as const;

export const BLE_CONFIG = {
  targetDeviceName: 'EMULOGGER',
  targetDeviceId: '98:DA:20:07:E0:AC',
  preferredServiceUuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
  preferredNotifyCharacteristicUuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
  requestedMtu: 247,
  scanTimeoutMs: 20_000,
  connectionTimeoutMs: 15_000,
  uiRefreshMs: 500,
  expectedRatesHz: {
    rpm: 25,
    iat: 6.25,
    clt: 6.25,
  },
} as const;
