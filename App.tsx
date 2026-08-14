import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { toByteArray } from 'base64-js';
import {
  BleError,
  BleManager,
  ConnectionPriority,
  LogLevel,
  ScanMode,
  State,
} from 'react-native-ble-plx';
import type { Characteristic, Device, Subscription } from 'react-native-ble-plx';
import RNBluetoothClassic from 'react-native-bluetooth-classic';

import { BleStatsCollector } from './src/BleStatsCollector';
import type {
  BleStatsSnapshot,
  ChannelStatsSnapshot,
  DistributionSnapshot,
} from './src/BleStatsCollector';
import { BLE_CONFIG } from './src/config';
import { monotonicNowMs } from './src/time';

type TransportMode = 'ble' | 'spp';
type ClassicDeviceType = 'CLASSIC' | 'LOW_ENERGY' | 'DUAL' | 'UNKNOWN';
type ClassicRxEncoding = 'unknown' | 'base64' | 'binary-string';

type ConnectionState =
  | 'idle'
  | 'waiting-for-bluetooth'
  | 'scanning'
  | 'scan-results'
  | 'pairing'
  | 'connecting'
  | 'discovering'
  | 'subscribing'
  | 'receiving'
  | 'disconnecting'
  | 'disconnected'
  | 'error';

interface RemovableSubscription {
  remove(): void;
}

interface ClassicNativeDeviceLike {
  address?: string;
  id?: string;
  name?: string;
}

interface ClassicReadEventLike {
  data: string;
  device?: ClassicNativeDeviceLike;
}

interface ClassicDeviceEventLike {
  device?: ClassicNativeDeviceLike;
  message?: string;
  error?: unknown;
}

interface ClassicDeviceLike {
  name?: string;
  address?: string;
  id?: string;
  bonded?: boolean | Boolean;
  deviceClass?: string | Record<string, unknown>;
  rssi?: number | Number;
  type?: string;
  extra?: unknown;
  connect(options?: Record<string, unknown>): Promise<boolean>;
  isConnected(): Promise<boolean>;
  disconnect(): Promise<boolean>;
  onDataReceived(listener: (event: ClassicReadEventLike) => void): RemovableSubscription;
}

interface ClassicModuleLike {
  isBluetoothAvailable(): Promise<boolean>;
  isBluetoothEnabled(): Promise<boolean>;
  requestBluetoothEnabled(): Promise<boolean>;
  getBondedDevices(): Promise<ClassicDeviceLike[]>;
  startDiscovery(): Promise<ClassicDeviceLike[]>;
  cancelDiscovery(): Promise<boolean>;
  pairDevice(address: string): Promise<ClassicDeviceLike>;
  onDeviceDisconnected(
    listener: (event: ClassicDeviceEventLike) => void,
  ): RemovableSubscription;
  onError(listener: (event: ClassicDeviceEventLike) => void): RemovableSubscription;
}

const ClassicBluetooth = RNBluetoothClassic as unknown as ClassicModuleLike;

interface BleConnectedInfo {
  transport: 'ble';
  id: string;
  name: string;
  scanRssi: number | null;
  mtu: number;
  serviceUuid: string;
  notifyCharacteristicUuid: string;
  characteristicSummary: string;
  connectedAtIso: string;
}

interface SppConnectedInfo {
  transport: 'spp';
  id: string;
  address: string;
  name: string;
  bonded: boolean;
  deviceType: ClassicDeviceType;
  scanRssi: number | null;
  secureSocket: boolean;
  readSize: number;
  connectedAtIso: string;
}

type ConnectedInfo = BleConnectedInfo | SppConnectedInfo;

interface BleScanDeviceRow {
  id: string;
  name: string | null;
  localName: string | null;
  rssi: number | null;
  isConnectable: boolean | null;
  serviceUUIDs: string[] | null;
}

interface SppScanDeviceRow {
  id: string;
  address: string;
  name: string;
  bonded: boolean;
  type: ClassicDeviceType;
  rssi: number | null;
}

const SPP_READ_SIZE = 8192;

function normalizedUuid(uuid: string): string {
  return uuid.trim().toLowerCase();
}

function bleDeviceDisplayName(
  device: Pick<BleScanDeviceRow, 'id' | 'name' | 'localName'>,
): string {
  return device.localName ?? device.name ?? '(bez nazwy)';
}

function bleDeviceToRow(device: Device): BleScanDeviceRow {
  return {
    id: device.id,
    name: device.name ?? null,
    localName: device.localName ?? null,
    rssi: device.rssi ?? null,
    isConnectable: device.isConnectable ?? null,
    serviceUUIDs: device.serviceUUIDs ?? null,
  };
}

function sortBleDevices(rows: BleScanDeviceRow[]): BleScanDeviceRow[] {
  return rows.sort((a, b) => {
    const aRssi = a.rssi ?? -999;
    const bRssi = b.rssi ?? -999;
    if (aRssi !== bRssi) {
      return bRssi - aRssi;
    }
    return bleDeviceDisplayName(a).localeCompare(bleDeviceDisplayName(b));
  });
}

function finiteNumber(value: unknown): number | null {
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

function classicAddress(device: ClassicDeviceLike): string {
  return device.address ?? device.id ?? '';
}

function classicDeviceName(device: ClassicDeviceLike): string {
  const name = device.name?.trim();
  return name && name.length > 0 ? name : '(bez nazwy)';
}

function classicDeviceType(device: ClassicDeviceLike): ClassicDeviceType {
  const value = String(device.type ?? 'UNKNOWN').toUpperCase();
  if (value === 'CLASSIC' || value === 'LOW_ENERGY' || value === 'DUAL') {
    return value;
  }
  return 'UNKNOWN';
}

function classicDeviceRssi(device: ClassicDeviceLike): number | null {
  const direct = finiteNumber(device.rssi);
  if (direct !== null && direct !== 0) {
    return direct;
  }

  const extra = device.extra;
  if (extra instanceof Map) {
    const mapped = finiteNumber(extra.get('rssi'));
    return mapped === 0 ? null : mapped;
  }
  if (typeof extra === 'object' && extra !== null && 'rssi' in extra) {
    const mapped = finiteNumber((extra as { rssi?: unknown }).rssi);
    return mapped === 0 ? null : mapped;
  }
  return null;
}

function classicDeviceToRow(device: ClassicDeviceLike): SppScanDeviceRow | null {
  const address = classicAddress(device);
  if (address.length === 0) {
    return null;
  }
  const type = classicDeviceType(device);
  if (type === 'LOW_ENERGY') {
    return null;
  }
  return {
    id: device.id ?? address,
    address,
    name: classicDeviceName(device),
    bonded: Boolean(device.bonded),
    type,
    rssi: classicDeviceRssi(device),
  };
}

function sortSppDevices(rows: SppScanDeviceRow[]): SppScanDeviceRow[] {
  return rows.sort((a, b) => {
    if (a.bonded !== b.bonded) {
      return a.bonded ? -1 : 1;
    }
    const aRssi = a.rssi ?? -999;
    const bRssi = b.rssi ?? -999;
    if (aRssi !== bRssi) {
      return bRssi - aRssi;
    }
    return a.name.localeCompare(b.name);
  });
}

async function requestAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }

  const apiLevel = Number(Platform.Version);
  if (apiLevel >= 31) {
    const result = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return (
      result[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] ===
        PermissionsAndroid.RESULTS.GRANTED &&
      result[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] ===
        PermissionsAndroid.RESULTS.GRANTED
    );
  }

  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

async function waitForBlePoweredOn(manager: BleManager): Promise<void> {
  const initialState = await manager.state();
  if (initialState === State.PoweredOn) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let subscription: Subscription | null = null;
    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        subscription?.remove();
        reject(new Error('Bluetooth nie przeszedł do stanu PoweredOn w ciągu 10 s.'));
      }
    }, 10_000);

    subscription = manager.onStateChange((state) => {
      if (finished) {
        return;
      }
      if (state === State.PoweredOn) {
        finished = true;
        clearTimeout(timeout);
        subscription?.remove();
        resolve();
      } else if (
        state === State.PoweredOff ||
        state === State.Unauthorized ||
        state === State.Unsupported
      ) {
        finished = true;
        clearTimeout(timeout);
        subscription?.remove();
        reject(new Error(`Bluetooth state: ${state}`));
      }
    }, true);
  });
}

async function ensureClassicBluetoothReady(): Promise<void> {
  if (Platform.OS !== 'android') {
    throw new Error('Test SPP w tej aplikacji jest przeznaczony dla Androida.');
  }
  if (!(await ClassicBluetooth.isBluetoothAvailable())) {
    throw new Error('Telefon nie zgłasza obsługi Bluetooth Classic.');
  }
  if (!(await ClassicBluetooth.isBluetoothEnabled())) {
    const enabled = await ClassicBluetooth.requestBluetoothEnabled();
    if (!enabled) {
      throw new Error('Bluetooth nie został włączony.');
    }
  }
}

function formatNumber(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) {
    return '—';
  }
  return value.toFixed(digits);
}

function formatDistribution(value: DistributionSnapshot): string {
  return `med ${formatNumber(value.median, 1)} | p95 ${formatNumber(
    value.p95,
    1,
  )} | p99 ${formatNumber(value.p99, 1)} | max ${formatNumber(value.max, 1)}`;
}

function emptySnapshot(): BleStatsSnapshot {
  const channel = (id: number, expectedRateHz: number): ChannelStatsSnapshot => ({
    id,
    count: 0,
    averageRateHz: 0,
    recentRateHz: 0,
    expectedRateHz,
    estimatedDeliveryPercent: 0,
    latestRaw: null,
    lastSeenAgoMs: null,
  });
  const emptyDistribution: DistributionSnapshot = {
    min: null,
    median: null,
    p95: null,
    p99: null,
    max: null,
  };
  return {
    elapsedSeconds: 0,
    notifications: 0,
    notificationsPerSecondAverage: 0,
    notificationsPerSecond1s: 0,
    bytes: 0,
    bytesPerSecondAverage: 0,
    bytesPerSecond1s: 0,
    validFrames: 0,
    validFramesPerSecondAverage: 0,
    validFramesPerSecond1s: 0,
    checksumErrors: 0,
    markerResyncDrops: 0,
    carryBytes: 0,
    notificationLengthsNotMultipleOf5: 0,
    exactConsecutiveDuplicateNotifications: 0,
    notificationLengthHistogram: [],
    channelCounts: [],
    notificationGapMs: emptyDistribution,
    callbackDurationMs: emptyDistribution,
    jsEventLoopLagMs: emptyDistribution,
    rpm: channel(1, BLE_CONFIG.expectedRatesHz.rpm),
    iat: channel(4, BLE_CONFIG.expectedRatesHz.iat),
    clt: channel(24, BLE_CONFIG.expectedRatesHz.clt),
    rpmToCltRatio: null,
    iatToCltRatio: null,
  };
}

function errorDescription(error: unknown): string {
  if (error instanceof BleError) {
    return [
      error.message,
      `errorCode=${error.errorCode}`,
      error.androidErrorCode !== null ? `android=${error.androidErrorCode}` : null,
      error.attErrorCode !== null ? `att=${error.attErrorCode}` : null,
      error.reason ? `reason=${error.reason}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}

function decodeClassicPayload(data: string): {
  payload: Uint8Array;
  encoding: Exclude<ClassicRxEncoding, 'unknown'>;
} {
  const compact = data.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    try {
      const padded = compact + '='.repeat((4 - (compact.length % 4)) % 4);
      return { payload: toByteArray(padded), encoding: 'base64' };
    } catch {
      // Fallback poniżej dla implementacji zwracającej bezpośredni string binarny.
    }
  }

  const payload = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    payload[index] = data.charCodeAt(index) & 0xff;
  }
  return { payload, encoding: 'binary-string' };
}

function ChannelRow({ label, value }: { label: string; value: ChannelStatsSnapshot }) {
  return (
    <View style={styles.channelBox}>
      <Text style={styles.channelTitle}>
        {label} (ID {value.id})
      </Text>
      <Text style={styles.mono}>
        count={value.count} | avg={formatNumber(value.averageRateHz, 2)} Hz | 5s=
        {formatNumber(value.recentRateHz, 2)} Hz
      </Text>
      <Text style={styles.mono}>
        expected={formatNumber(value.expectedRateHz, 2)} Hz | rate vs nominal≈
        {formatNumber(value.estimatedDeliveryPercent, 1)}% | raw={value.latestRaw ?? '—'} | age=
        {formatNumber(value.lastSeenAgoMs, 0)} ms
      </Text>
    </View>
  );
}

export default function App() {
  const manager = useMemo(() => new BleManager(), []);
  const collectorRef = useRef(new BleStatsCollector());

  const bleMonitorSubscriptionRef = useRef<Subscription | null>(null);
  const bleDisconnectSubscriptionRef = useRef<Subscription | null>(null);
  const classicDataSubscriptionRef = useRef<RemovableSubscription | null>(null);
  const classicDisconnectSubscriptionRef = useRef<RemovableSubscription | null>(null);
  const classicErrorSubscriptionRef = useRef<RemovableSubscription | null>(null);

  const bleScanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bleScanUiTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const classicScanGenerationRef = useRef(0);

  const discoveredBleObjectsRef = useRef<Map<string, Device>>(new Map());
  const discoveredBleRowsRef = useRef<Map<string, BleScanDeviceRow>>(new Map());
  const discoveredSppObjectsRef = useRef<Map<string, ClassicDeviceLike>>(new Map());
  const discoveredSppRowsRef = useRef<Map<string, SppScanDeviceRow>>(new Map());

  const connectingRef = useRef(false);
  const connectedTransportRef = useRef<TransportMode | null>(null);
  const connectedBleDeviceIdRef = useRef<string | null>(null);
  const connectedSppDeviceRef = useRef<ClassicDeviceLike | null>(null);
  const intentionalDisconnectRef = useRef(false);
  const transportDecodeErrorsRef = useRef(0);
  const classicRxEncodingRef = useRef<ClassicRxEncoding>('unknown');

  const [transportMode, setTransportMode] = useState<TransportMode>('ble');
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [statusText, setStatusText] = useState(
    'Wybierz BLE albo SPP, zeskanuj urządzenia i połącz się z wybranym modułem.',
  );
  const [errorText, setErrorText] = useState<string | null>(null);
  const [connectedInfo, setConnectedInfo] = useState<ConnectedInfo | null>(null);
  const [bleScanDevices, setBleScanDevices] = useState<BleScanDeviceRow[]>([]);
  const [sppScanDevices, setSppScanDevices] = useState<SppScanDeviceRow[]>([]);
  const [stats, setStats] = useState<BleStatsSnapshot>(() => emptySnapshot());
  const [transportDecodeErrors, setTransportDecodeErrors] = useState(0);
  const [classicRxEncoding, setClassicRxEncoding] = useState<ClassicRxEncoding>('unknown');

  const refreshBleScanList = useCallback(() => {
    setBleScanDevices(sortBleDevices(Array.from(discoveredBleRowsRef.current.values())));
  }, []);

  const refreshSppScanList = useCallback(() => {
    setSppScanDevices(sortSppDevices(Array.from(discoveredSppRowsRef.current.values())));
  }, []);

  const mergeSppDevices = useCallback(
    (devices: ClassicDeviceLike[], forceBonded = false) => {
      for (const device of devices) {
        const row = classicDeviceToRow(device);
        if (row === null) {
          continue;
        }
        const previous = discoveredSppRowsRef.current.get(row.address);
        const merged: SppScanDeviceRow = {
          ...row,
          bonded: forceBonded || row.bonded || previous?.bonded === true,
          rssi: row.rssi ?? previous?.rssi ?? null,
          name: row.name === '(bez nazwy)' ? previous?.name ?? row.name : row.name,
        };
        discoveredSppObjectsRef.current.set(row.address, device);
        discoveredSppRowsRef.current.set(row.address, merged);
      }
      refreshSppScanList();
    },
    [refreshSppScanList],
  );

  const stopBleScan = useCallback(() => {
    if (bleScanTimeoutRef.current !== null) {
      clearTimeout(bleScanTimeoutRef.current);
      bleScanTimeoutRef.current = null;
    }
    if (bleScanUiTimerRef.current !== null) {
      clearInterval(bleScanUiTimerRef.current);
      bleScanUiTimerRef.current = null;
    }
    void manager.stopDeviceScan().catch(() => undefined);
  }, [manager]);

  const cancelSppDiscovery = useCallback(async (invalidate = true): Promise<void> => {
    if (invalidate) {
      classicScanGenerationRef.current += 1;
    }
    try {
      await ClassicBluetooth.cancelDiscovery();
    } catch {
      // Brak aktywnego discovery nie jest błędem.
    }
  }, []);

  const stopAllScans = useCallback(() => {
    stopBleScan();
    void cancelSppDiscovery(true);
  }, [cancelSppDiscovery, stopBleScan]);

  const finishBleScan = useCallback(
    (message?: string) => {
      stopBleScan();
      refreshBleScanList();
      setConnectionState('scan-results');
      setStatusText(
        message ??
          `Skan BLE zakończony. Znaleziono ${discoveredBleRowsRef.current.size} urządzeń.`,
      );
    },
    [refreshBleScanList, stopBleScan],
  );

  const finishSppScan = useCallback(
    (message?: string) => {
      void cancelSppDiscovery(true);
      refreshSppScanList();
      setConnectionState('scan-results');
      setStatusText(
        message ??
          `Skan SPP zakończony. Na liście jest ${discoveredSppRowsRef.current.size} urządzeń Classic/DUAL.`,
      );
    },
    [cancelSppDiscovery, refreshSppScanList],
  );

  const removeSubscriptions = useCallback(() => {
    bleMonitorSubscriptionRef.current?.remove();
    bleMonitorSubscriptionRef.current = null;
    bleDisconnectSubscriptionRef.current?.remove();
    bleDisconnectSubscriptionRef.current = null;
    classicDataSubscriptionRef.current?.remove();
    classicDataSubscriptionRef.current = null;
    classicDisconnectSubscriptionRef.current?.remove();
    classicDisconnectSubscriptionRef.current = null;
    classicErrorSubscriptionRef.current?.remove();
    classicErrorSubscriptionRef.current = null;
  }, []);

  const resetStats = useCallback(() => {
    collectorRef.current.reset(monotonicNowMs());
    transportDecodeErrorsRef.current = 0;
    classicRxEncodingRef.current = 'unknown';
    setTransportDecodeErrors(0);
    setClassicRxEncoding('unknown');
    setStats(emptySnapshot());
  }, []);

  const installBleMonitor = useCallback(
    async (device: Device, scanRssi: number | null): Promise<void> => {
      setConnectionState('discovering');
      setStatusText('Wykrywanie usług i charakterystyk BLE…');
      const preparedDevice = await device.discoverAllServicesAndCharacteristics();

      const services = await preparedDevice.services();
      const preferredService = normalizedUuid(BLE_CONFIG.preferredServiceUuid);
      const preferredNotify = normalizedUuid(BLE_CONFIG.preferredNotifyCharacteristicUuid);
      const orderedServices = [...services].sort((a, b) => {
        const aPreferred = normalizedUuid(a.uuid) === preferredService ? 0 : 1;
        const bPreferred = normalizedUuid(b.uuid) === preferredService ? 0 : 1;
        return aPreferred - bPreferred;
      });

      let notifyCharacteristic: Characteristic | null = null;
      const characteristicDescriptions: string[] = [];

      for (const service of orderedServices) {
        const characteristics = await preparedDevice.characteristicsForService(service.uuid);
        for (const characteristic of characteristics) {
          characteristicDescriptions.push(
            `${service.uuid}/${characteristic.uuid} ` +
              `[N=${characteristic.isNotifiable ? 1 : 0}, I=${
                characteristic.isIndicatable ? 1 : 0
              }, W=${characteristic.isWritableWithoutResponse ? 1 : 0}]`,
          );
        }

        const preferred = characteristics.find(
          (characteristic) =>
            normalizedUuid(characteristic.uuid) === preferredNotify &&
            (characteristic.isNotifiable || characteristic.isIndicatable),
        );
        const fallback = characteristics.find(
          (characteristic) => characteristic.isNotifiable || characteristic.isIndicatable,
        );

        if (preferred !== undefined || fallback !== undefined) {
          notifyCharacteristic = preferred ?? fallback ?? null;
          break;
        }
      }

      if (notifyCharacteristic === null) {
        throw new Error(
          `Nie znaleziono charakterystyki notify/indicate. Odkryto: ${characteristicDescriptions.join(
            '; ',
          )}`,
        );
      }

      setConnectionState('subscribing');
      setStatusText(`Subskrypcja ${notifyCharacteristic.serviceUUID}/${notifyCharacteristic.uuid}…`);
      resetStats();

      setConnectedInfo({
        transport: 'ble',
        id: preparedDevice.id,
        name: preparedDevice.localName ?? preparedDevice.name ?? '(bez nazwy)',
        scanRssi,
        mtu: preparedDevice.mtu,
        serviceUuid: notifyCharacteristic.serviceUUID,
        notifyCharacteristicUuid: notifyCharacteristic.uuid,
        characteristicSummary: characteristicDescriptions.join('\n'),
        connectedAtIso: new Date().toISOString(),
      });

      bleMonitorSubscriptionRef.current = preparedDevice.monitorCharacteristicForService(
        notifyCharacteristic.serviceUUID,
        notifyCharacteristic.uuid,
        (error, characteristic) => {
          const callbackStartedAt = monotonicNowMs();
          try {
            if (error !== null) {
              if (!intentionalDisconnectRef.current) {
                setErrorText(errorDescription(error));
                setConnectionState('error');
              }
              return;
            }

            const base64Value = characteristic?.value;
            if (base64Value === null || base64Value === undefined) {
              return;
            }

            const payload = toByteArray(base64Value);
            collectorRef.current.ingestNotification(payload, callbackStartedAt);
          } catch {
            transportDecodeErrorsRef.current += 1;
          } finally {
            collectorRef.current.recordCallbackDuration(monotonicNowMs() - callbackStartedAt);
          }
        },
        'ecumaster-rx-monitor',
      );

      bleDisconnectSubscriptionRef.current = manager.onDeviceDisconnected(
        preparedDevice.id,
        (error) => {
          connectedBleDeviceIdRef.current = null;
          connectedTransportRef.current = null;
          connectingRef.current = false;
          bleMonitorSubscriptionRef.current?.remove();
          bleMonitorSubscriptionRef.current = null;
          setConnectionState('disconnected');
          setStatusText(
            intentionalDisconnectRef.current
              ? 'Rozłączono BLE ręcznie.'
              : 'Połączenie BLE zostało przerwane.',
          );
          if (!intentionalDisconnectRef.current && error !== null) {
            setErrorText(errorDescription(error));
          }
        },
      );

      connectedTransportRef.current = 'ble';
      connectingRef.current = false;
      setConnectionState('receiving');
      setStatusText('BLE: odbieranie notyfikacji. Brak logowania per ramka i brak operacji TX.');
    },
    [manager, resetStats],
  );

  const connectBleDevice = useCallback(
    async (scannedDevice: Device): Promise<void> => {
      setConnectionState('connecting');
      setStatusText(
        `Łączenie BLE z ${scannedDevice.localName ?? scannedDevice.name ?? scannedDevice.id}…`,
      );

      let device = await scannedDevice.connect({
        autoConnect: false,
        timeout: BLE_CONFIG.connectionTimeoutMs,
      });
      connectedBleDeviceIdRef.current = device.id;

      try {
        device = await manager.requestConnectionPriorityForDevice(
          device.id,
          ConnectionPriority.High,
          'ecumaster-high-priority',
        );
        setStatusText('Połączono BLE; wysłano żądanie CONNECTION_PRIORITY_HIGH.');
      } catch (error) {
        setStatusText(
          `Połączono BLE, ale żądanie high priority zwróciło błąd: ${errorDescription(error)}`,
        );
      }

      try {
        device = await manager.requestMTUForDevice(
          device.id,
          BLE_CONFIG.requestedMtu,
          'ecumaster-request-mtu',
        );
        setStatusText(`BLE high priority zażądane; MTU zwrócone przez bibliotekę: ${device.mtu}.`);
      } catch (error) {
        setStatusText(`BLE high priority zażądane; MTU request error: ${errorDescription(error)}`);
      }

      await installBleMonitor(device, scannedDevice.rssi ?? null);
    },
    [installBleMonitor, manager],
  );

  const startBleScan = useCallback(async () => {
    if (connectingRef.current || connectedTransportRef.current !== null) {
      return;
    }

    intentionalDisconnectRef.current = false;
    setErrorText(null);
    setConnectedInfo(null);
    removeSubscriptions();
    stopAllScans();
    discoveredBleObjectsRef.current.clear();
    discoveredBleRowsRef.current.clear();
    setBleScanDevices([]);

    try {
      const permissionsGranted = await requestAndroidPermissions();
      if (!permissionsGranted) {
        throw new Error('Brak uprawnień Bluetooth wymaganych do skanowania i połączenia.');
      }

      setConnectionState('waiting-for-bluetooth');
      setStatusText('Oczekiwanie na Bluetooth PoweredOn…');
      await waitForBlePoweredOn(manager);

      setConnectionState('scanning');
      setStatusText(
        `Skanowanie wszystkich urządzeń BLE przez ${BLE_CONFIG.scanTimeoutMs / 1000} s.`,
      );

      bleScanUiTimerRef.current = setInterval(refreshBleScanList, 300);
      bleScanTimeoutRef.current = setTimeout(() => finishBleScan(), BLE_CONFIG.scanTimeoutMs);

      await manager.startDeviceScan(
        null,
        { scanMode: ScanMode.LowLatency },
        (error, device) => {
          if (error !== null) {
            stopBleScan();
            setConnectionState('error');
            setErrorText(errorDescription(error));
            return;
          }
          if (device === null) {
            return;
          }
          discoveredBleObjectsRef.current.set(device.id, device);
          discoveredBleRowsRef.current.set(device.id, bleDeviceToRow(device));
        },
      );
    } catch (error) {
      stopBleScan();
      setConnectionState('error');
      setErrorText(errorDescription(error));
    }
  }, [finishBleScan, manager, refreshBleScanList, removeSubscriptions, stopAllScans, stopBleScan]);

  const startSppScan = useCallback(async () => {
    if (connectingRef.current || connectedTransportRef.current !== null) {
      return;
    }

    intentionalDisconnectRef.current = false;
    setErrorText(null);
    setConnectedInfo(null);
    removeSubscriptions();
    stopAllScans();
    discoveredSppObjectsRef.current.clear();
    discoveredSppRowsRef.current.clear();
    setSppScanDevices([]);

    const generation = classicScanGenerationRef.current + 1;
    classicScanGenerationRef.current = generation;

    try {
      const permissionsGranted = await requestAndroidPermissions();
      if (!permissionsGranted) {
        throw new Error('Brak uprawnień Bluetooth wymaganych do skanowania i połączenia SPP.');
      }

      setConnectionState('waiting-for-bluetooth');
      setStatusText('Sprawdzanie Bluetooth Classic…');
      await ensureClassicBluetoothReady();

      const bonded = await ClassicBluetooth.getBondedDevices();
      mergeSppDevices(bonded, true);

      setConnectionState('scanning');
      setStatusText(
        `SPP: pokazano ${bonded.length} sparowanych urządzeń. Trwa discovery urządzeń Classic/DUAL…`,
      );

      const discovered = await ClassicBluetooth.startDiscovery();
      if (classicScanGenerationRef.current !== generation) {
        return;
      }
      mergeSppDevices(discovered, false);
      setConnectionState('scan-results');
      setStatusText(
        'Skan SPP zakończony. Sparowane urządzenia są na górze; niesparowane można sparować przy połączeniu.',
      );
    } catch (error) {
      if (classicScanGenerationRef.current !== generation) {
        return;
      }
      setConnectionState('error');
      setErrorText(errorDescription(error));
    }
  }, [mergeSppDevices, removeSubscriptions, stopAllScans]);

  const connectSelectedBleDevice = useCallback(
    async (deviceId: string) => {
      if (connectingRef.current || connectedTransportRef.current !== null) {
        return;
      }
      const device = discoveredBleObjectsRef.current.get(deviceId);
      if (device === undefined) {
        setConnectionState('error');
        setErrorText('Wybrane urządzenie BLE nie jest już dostępne. Uruchom skan ponownie.');
        return;
      }

      intentionalDisconnectRef.current = false;
      connectingRef.current = true;
      setErrorText(null);
      stopAllScans();

      try {
        await connectBleDevice(device);
      } catch (connectError) {
        const failedDeviceId = connectedBleDeviceIdRef.current;
        if (failedDeviceId !== null) {
          void manager.cancelDeviceConnection(failedDeviceId).catch(() => undefined);
        }
        connectedBleDeviceIdRef.current = null;
        connectedTransportRef.current = null;
        connectingRef.current = false;
        setConnectionState('error');
        setErrorText(errorDescription(connectError));
      }
    },
    [connectBleDevice, manager, stopAllScans],
  );

  const installSppReceiver = useCallback(
    (device: ClassicDeviceLike, row: SppScanDeviceRow, secureSocket: boolean): void => {
      resetStats();
      const address = classicAddress(device);
      connectedSppDeviceRef.current = device;
      connectedTransportRef.current = 'spp';

      setConnectedInfo({
        transport: 'spp',
        id: device.id ?? address,
        address,
        name: classicDeviceName(device),
        bonded: true,
        deviceType: classicDeviceType(device),
        scanRssi: row.rssi,
        secureSocket,
        readSize: SPP_READ_SIZE,
        connectedAtIso: new Date().toISOString(),
      });

      classicDataSubscriptionRef.current = device.onDataReceived((event) => {
        const callbackStartedAt = monotonicNowMs();
        try {
          if (typeof event.data !== 'string' || event.data.length === 0) {
            return;
          }
          const decoded = decodeClassicPayload(event.data);
          if (classicRxEncodingRef.current === 'unknown') {
            classicRxEncodingRef.current = decoded.encoding;
          }
          if (decoded.payload.length > 0) {
            collectorRef.current.ingestNotification(decoded.payload, callbackStartedAt);
          }
        } catch {
          transportDecodeErrorsRef.current += 1;
        } finally {
          collectorRef.current.recordCallbackDuration(monotonicNowMs() - callbackStartedAt);
        }
      });

      classicDisconnectSubscriptionRef.current = ClassicBluetooth.onDeviceDisconnected((event) => {
        const eventAddress = event.device?.address ?? event.device?.id;
        if (
          eventAddress !== undefined &&
          eventAddress.toUpperCase() !== address.toUpperCase()
        ) {
          return;
        }
        connectedSppDeviceRef.current = null;
        connectedTransportRef.current = null;
        connectingRef.current = false;
        classicDataSubscriptionRef.current?.remove();
        classicDataSubscriptionRef.current = null;
        setConnectionState('disconnected');
        setStatusText(
          intentionalDisconnectRef.current
            ? 'Rozłączono SPP ręcznie.'
            : 'Połączenie SPP zostało przerwane.',
        );
      });

      classicErrorSubscriptionRef.current = ClassicBluetooth.onError((event) => {
        const eventAddress = event.device?.address ?? event.device?.id;
        if (
          eventAddress !== undefined &&
          eventAddress.toUpperCase() !== address.toUpperCase()
        ) {
          return;
        }
        if (!intentionalDisconnectRef.current) {
          setErrorText(event.message ?? 'Natywna warstwa Bluetooth Classic zgłosiła błąd.');
        }
      });

      connectingRef.current = false;
      setConnectionState('receiving');
      setStatusText(
        `SPP: odbieranie binarnego strumienia RFCOMM, READ_SIZE=${SPP_READ_SIZE}, socket ${
          secureSocket ? 'secure' : 'insecure'
        }.`,
      );
    },
    [resetStats],
  );

  const connectSelectedSppDevice = useCallback(
    async (address: string) => {
      if (connectingRef.current || connectedTransportRef.current !== null) {
        return;
      }
      const initialDevice = discoveredSppObjectsRef.current.get(address);
      const row = discoveredSppRowsRef.current.get(address);
      if (initialDevice === undefined || row === undefined) {
        setConnectionState('error');
        setErrorText('Wybrane urządzenie SPP nie jest już dostępne. Uruchom skan ponownie.');
        return;
      }

      intentionalDisconnectRef.current = false;
      connectingRef.current = true;
      setErrorText(null);
      stopBleScan();
      await cancelSppDiscovery(true);

      let device = initialDevice;
      try {
        if (!row.bonded && !Boolean(device.bonded)) {
          setConnectionState('pairing');
          setStatusText(`Parowanie SPP z ${row.name} (${address})…`);
          device = await ClassicBluetooth.pairDevice(address);
          mergeSppDevices([device], true);
        }

        setConnectionState('connecting');
        setStatusText(`Łączenie SPP/RFCOMM z ${classicDeviceName(device)} (${address})…`);

        try {
          if (await device.isConnected()) {
            await device.disconnect();
          }
        } catch {
          // Kontynuujemy próbę połączenia w żądanym trybie binarnym.
        }

        const commonOptions: Record<string, unknown> = {
          CONNECTOR_TYPE: 'rfcomm',
          CONNECTION_TYPE: 'binary',
          READ_SIZE: SPP_READ_SIZE,
          READ_TIMEOUT: 0,
        };

        let secureSocket = true;
        let connected = false;
        let secureError: unknown = null;
        try {
          connected = await device.connect({ ...commonOptions, SECURE_SOCKET: true });
        } catch (error) {
          secureError = error;
        }

        if (!connected) {
          try {
            await device.disconnect();
          } catch {
            // Socket mógł nie zostać utworzony.
          }
          setStatusText(
            `Secure RFCOMM nie połączył się (${errorDescription(
              secureError,
            )}). Próba insecure RFCOMM…`,
          );
          secureSocket = false;
          connected = await device.connect({ ...commonOptions, SECURE_SOCKET: false });
        }

        if (!connected) {
          throw new Error('Biblioteka zwróciła false podczas łączenia SPP.');
        }

        installSppReceiver(device, { ...row, bonded: true }, secureSocket);
      } catch (error) {
        try {
          await device.disconnect();
        } catch {
          // Ignorujemy błąd sprzątania po nieudanym connect.
        }
        connectedSppDeviceRef.current = null;
        connectedTransportRef.current = null;
        connectingRef.current = false;
        setConnectionState('error');
        setErrorText(errorDescription(error));
      }
    },
    [cancelSppDiscovery, installSppReceiver, mergeSppDevices, stopBleScan],
  );

  const disconnect = useCallback(async () => {
    intentionalDisconnectRef.current = true;
    stopAllScans();
    removeSubscriptions();
    const currentTransport = connectedTransportRef.current;
    connectedTransportRef.current = null;
    connectingRef.current = false;

    setConnectionState('disconnecting');
    if (currentTransport === 'ble') {
      const deviceId = connectedBleDeviceIdRef.current;
      connectedBleDeviceIdRef.current = null;
      if (deviceId !== null) {
        try {
          await manager.cancelDeviceConnection(deviceId);
        } catch {
          // Połączenie mogło już zostać zamknięte przez system.
        }
      }
    } else if (currentTransport === 'spp') {
      const device = connectedSppDeviceRef.current;
      connectedSppDeviceRef.current = null;
      if (device !== null) {
        try {
          await device.disconnect();
        } catch {
          // Połączenie mogło już zostać zamknięte przez system.
        }
      }
    }

    setConnectionState('disconnected');
    setStatusText('Rozłączono ręcznie. Możesz ponownie uruchomić skan.');
  }, [manager, removeSubscriptions, stopAllScans]);

  const changeTransport = useCallback(
    (nextTransport: TransportMode) => {
      if (nextTransport === transportMode || connectedTransportRef.current !== null) {
        return;
      }
      stopAllScans();
      removeSubscriptions();
      connectingRef.current = false;
      setTransportMode(nextTransport);
      setConnectionState('idle');
      setConnectedInfo(null);
      setErrorText(null);
      resetStats();
      setStatusText(
        nextTransport === 'ble'
          ? 'Wybrano BLE/GATT. Kliknij „Skanuj BLE”.'
          : 'Wybrano SPP/Classic. Sparowane urządzenia pojawią się od razu po rozpoczęciu skanu.',
      );
    },
    [removeSubscriptions, resetStats, stopAllScans, transportMode],
  );

  const startSelectedScan = useCallback(async () => {
    if (transportMode === 'ble') {
      await startBleScan();
    } else {
      await startSppScan();
    }
  }, [startBleScan, startSppScan, transportMode]);

  const stopSelectedScan = useCallback(() => {
    if (transportMode === 'ble') {
      finishBleScan('Skan BLE zatrzymany ręcznie.');
    } else {
      finishSppScan('Skan SPP zatrzymany ręcznie.');
    }
  }, [finishBleScan, finishSppScan, transportMode]);

  const shareReport = useCallback(async () => {
    const infoLines: Array<string | null> = [];
    if (connectedInfo?.transport === 'ble') {
      infoLines.push(
        'transport=BLE_GATT',
        `connected_at=${connectedInfo.connectedAtIso}`,
        `device=${connectedInfo.name} ${connectedInfo.id}`,
        `scan_rssi=${connectedInfo.scanRssi ?? '—'} dBm`,
        `mtu=${connectedInfo.mtu}`,
        `service=${connectedInfo.serviceUuid}`,
        `notify=${connectedInfo.notifyCharacteristicUuid}`,
      );
    } else if (connectedInfo?.transport === 'spp') {
      infoLines.push(
        'transport=SPP_RFCOMM',
        `connected_at=${connectedInfo.connectedAtIso}`,
        `device=${connectedInfo.name} ${connectedInfo.address}`,
        `scan_rssi=${connectedInfo.scanRssi ?? '—'} dBm`,
        `bonded=${connectedInfo.bonded}`,
        `device_type=${connectedInfo.deviceType}`,
        `secure_socket=${connectedInfo.secureSocket}`,
        `read_size=${connectedInfo.readSize}`,
        `rx_bridge_encoding=${classicRxEncoding}`,
      );
    } else {
      infoLines.push(`transport_selected=${transportMode.toUpperCase()}`, 'device=—');
    }

    const eventName = transportMode === 'ble' ? 'notifications' : 'read_callbacks';
    const report = [
      'ECUMaster BT RX Stats v1.3',
      `generated=${new Date().toISOString()}`,
      `state=${connectionState}`,
      `status=${statusText}`,
      ...infoLines,
      `elapsed_s=${stats.elapsedSeconds.toFixed(3)}`,
      `${eventName}=${stats.notifications}`,
      `${eventName}_per_s_avg=${stats.notificationsPerSecondAverage.toFixed(3)}`,
      `bytes=${stats.bytes}`,
      `bytes_per_s_avg=${stats.bytesPerSecondAverage.toFixed(3)}`,
      `frames=${stats.validFrames}`,
      `frames_per_s_avg=${stats.validFramesPerSecondAverage.toFixed(3)}`,
      `transport_decode_errors=${transportDecodeErrors}`,
      `checksum_errors=${stats.checksumErrors}`,
      `resync_dropped_bytes=${stats.markerResyncDrops}`,
      `carry_bytes=${stats.carryBytes}`,
      `chunks_not_multiple_of_5=${stats.notificationLengthsNotMultipleOf5}`,
      `consecutive_exact_duplicate_chunks=${stats.exactConsecutiveDuplicateNotifications}`,
      `RPM_count=${stats.rpm.count} RPM_avg_hz=${stats.rpm.averageRateHz.toFixed(
        3,
      )} RPM_rate_vs_nominal_pct=${stats.rpm.estimatedDeliveryPercent.toFixed(2)}`,
      `IAT_count=${stats.iat.count} IAT_avg_hz=${stats.iat.averageRateHz.toFixed(
        3,
      )} IAT_rate_vs_nominal_pct=${stats.iat.estimatedDeliveryPercent.toFixed(2)}`,
      `CLT_count=${stats.clt.count} CLT_avg_hz=${stats.clt.averageRateHz.toFixed(
        3,
      )} CLT_rate_vs_nominal_pct=${stats.clt.estimatedDeliveryPercent.toFixed(2)}`,
      `RPM_to_CLT=${stats.rpmToCltRatio ?? '—'}`,
      `IAT_to_CLT=${stats.iatToCltRatio ?? '—'}`,
      `chunk_lengths=${stats.notificationLengthHistogram
        .map(([length, count]) => `${length}:${count}`)
        .join(',')}`,
      `channel_counts=${stats.channelCounts.map(([id, count]) => `${id}:${count}`).join(',')}`,
      `chunk_gap_ms=${JSON.stringify(stats.notificationGapMs)}`,
      `callback_duration_ms=${JSON.stringify(stats.callbackDurationMs)}`,
      `js_event_loop_lag_ms=${JSON.stringify(stats.jsEventLoopLagMs)}`,
      connectedInfo?.transport === 'ble'
        ? `characteristics=\n${connectedInfo.characteristicSummary}`
        : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');

    await Share.share({ title: 'ECUMaster BT RX Stats', message: report });
  }, [
    classicRxEncoding,
    connectedInfo,
    connectionState,
    stats,
    statusText,
    transportDecodeErrors,
    transportMode,
  ]);

  useEffect(() => {
    void manager.setLogLevel(LogLevel.None).catch(() => undefined);

    const uiTimer = setInterval(() => {
      setStats(collectorRef.current.snapshot(monotonicNowMs()));
      setTransportDecodeErrors(transportDecodeErrorsRef.current);
      setClassicRxEncoding(classicRxEncodingRef.current);
    }, BLE_CONFIG.uiRefreshMs);

    const lagIntervalMs = 100;
    let nextExpected = monotonicNowMs() + lagIntervalMs;
    const lagTimer = setInterval(() => {
      const now = monotonicNowMs();
      const lag = Math.max(0, now - nextExpected);
      collectorRef.current.recordJsEventLoopLag(lag);
      nextExpected += lagIntervalMs;
      if (now - nextExpected > lagIntervalMs * 5) {
        nextExpected = now + lagIntervalMs;
      }
    }, lagIntervalMs);

    return () => {
      intentionalDisconnectRef.current = true;
      clearInterval(uiTimer);
      clearInterval(lagTimer);
      stopBleScan();
      void cancelSppDiscovery(true);
      removeSubscriptions();
      const bleDeviceId = connectedBleDeviceIdRef.current;
      if (bleDeviceId !== null) {
        void manager.cancelDeviceConnection(bleDeviceId).catch(() => undefined);
      }
      const sppDevice = connectedSppDeviceRef.current;
      if (sppDevice !== null) {
        void sppDevice.disconnect().catch(() => undefined);
      }
      void manager.destroy().catch(() => undefined);
    };
  }, [cancelSppDiscovery, manager, removeSubscriptions, stopBleScan]);

  const isConnectionBusy = [
    'waiting-for-bluetooth',
    'pairing',
    'connecting',
    'discovering',
    'subscribing',
    'receiving',
    'disconnecting',
  ].includes(connectionState);
  const hasActiveConnection =
    connectedTransportRef.current !== null || connectionState === 'receiving';
  const canSwitchTransport =
    !isConnectionBusy && connectionState !== 'scanning' && !hasActiveConnection;
  const canStartScan =
    !isConnectionBusy && connectionState !== 'scanning' && !hasActiveConnection;
  const canConnectFromList = !connectingRef.current && !hasActiveConnection;
  const canDisconnect = isConnectionBusy || hasActiveConnection;

  const eventLabel = transportMode === 'ble' ? 'notifications' : 'SPP read callbacks';
  const callbackLabel = transportMode === 'ble' ? 'BLE callback' : 'SPP callback';
  const histogramText =
    stats.notificationLengthHistogram.length === 0
      ? '—'
      : stats.notificationLengthHistogram
          .map(([length, count]) => `${length} B: ${count}`)
          .join(' | ');

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#f2f3f5" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>ECUMaster BT RX Stats v1.3</Text>
        <Text style={styles.subtitle}>
          Minimalny miernik RX dla BLE/GATT i SPP/RFCOMM. Ten sam parser i te same statystyki dla obu transportów.
        </Text>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Wybór transportu</Text>
          <View style={styles.transportRow}>
            <Pressable
              onPress={() => changeTransport('ble')}
              disabled={!canSwitchTransport}
              style={[
                styles.transportButton,
                transportMode === 'ble' && styles.transportSelected,
                !canSwitchTransport && styles.disabledControl,
              ]}
            >
              <Text
                style={[
                  styles.transportText,
                  transportMode === 'ble' && styles.transportSelectedText,
                ]}
              >
                BLE / GATT
              </Text>
            </Pressable>
            <Pressable
              onPress={() => changeTransport('spp')}
              disabled={!canSwitchTransport}
              style={[
                styles.transportButton,
                transportMode === 'spp' && styles.transportSelected,
                !canSwitchTransport && styles.disabledControl,
              ]}
            >
              <Text
                style={[
                  styles.transportText,
                  transportMode === 'spp' && styles.transportSelectedText,
                ]}
              >
                SPP / RFCOMM
              </Text>
            </Pressable>
          </View>
          <Text style={styles.note}>
            Wybrano: {transportMode === 'ble' ? 'BLE/GATT' : 'SPP/RFCOMM'}. Transport można zmienić po zatrzymaniu skanu lub rozłączeniu.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Połączenie</Text>
          <Text style={styles.status}>{connectionState}</Text>
          <Text style={styles.bodyText}>{statusText}</Text>
          {[
            'waiting-for-bluetooth',
            'scanning',
            'pairing',
            'connecting',
            'discovering',
            'subscribing',
          ].includes(connectionState) ? (
            <ActivityIndicator style={styles.spinner} />
          ) : null}
          {errorText !== null ? <Text style={styles.error}>{errorText}</Text> : null}

          {connectedInfo?.transport === 'ble' ? (
            <View style={styles.infoBlock}>
              <Text style={styles.mono}>transport: BLE/GATT</Text>
              <Text style={styles.mono}>device: {connectedInfo.name}</Text>
              <Text style={styles.mono}>id: {connectedInfo.id}</Text>
              <Text style={styles.mono}>scan RSSI: {connectedInfo.scanRssi ?? '—'} dBm</Text>
              <Text style={styles.mono}>MTU reported: {connectedInfo.mtu}</Text>
              <Text style={styles.mono}>service: {connectedInfo.serviceUuid}</Text>
              <Text style={styles.mono}>notify: {connectedInfo.notifyCharacteristicUuid}</Text>
            </View>
          ) : null}

          {connectedInfo?.transport === 'spp' ? (
            <View style={styles.infoBlock}>
              <Text style={styles.mono}>transport: SPP/RFCOMM</Text>
              <Text style={styles.mono}>device: {connectedInfo.name}</Text>
              <Text style={styles.mono}>address: {connectedInfo.address}</Text>
              <Text style={styles.mono}>type: {connectedInfo.deviceType}</Text>
              <Text style={styles.mono}>socket: {connectedInfo.secureSocket ? 'secure' : 'insecure'}</Text>
              <Text style={styles.mono}>READ_SIZE: {connectedInfo.readSize}</Text>
              <Text style={styles.mono}>bridge encoding: {classicRxEncoding}</Text>
            </View>
          ) : null}

          <View style={styles.buttonRow}>
            <View style={styles.buttonCell}>
              <Button
                title={transportMode === 'ble' ? 'Skanuj BLE' : 'Skanuj SPP'}
                onPress={() => void startSelectedScan()}
                disabled={!canStartScan}
              />
            </View>
            <View style={styles.buttonCell}>
              <Button
                title="Zatrzymaj skan"
                onPress={stopSelectedScan}
                disabled={connectionState !== 'scanning'}
              />
            </View>
          </View>
          <View style={styles.buttonRow}>
            <View style={styles.buttonCell}>
              <Button title="Rozłącz" onPress={() => void disconnect()} disabled={!canDisconnect} />
            </View>
            <View style={styles.buttonCell}>
              <Button title="Reset statystyk" onPress={resetStats} />
            </View>
          </View>
          <View style={styles.singleButtonRow}>
            <Button title="Udostępnij raport" onPress={() => void shareReport()} />
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            {transportMode === 'ble' ? 'Znalezione urządzenia BLE' : 'Urządzenia SPP / Classic'} ({
              transportMode === 'ble' ? bleScanDevices.length : sppScanDevices.length
            })
          </Text>

          {transportMode === 'ble' ? (
            <Text style={styles.note}>
              Lista nie filtruje po nazwie, MAC ani UUID. Najsilniejsze urządzenia są na górze.
            </Text>
          ) : (
            <Text style={styles.note}>
              Urządzenia sparowane pojawiają się od razu na górze. Pełne discovery Bluetooth Classic może trwać kilkanaście sekund.
            </Text>
          )}

          {connectionState === 'scanning' ? <ActivityIndicator style={styles.spinner} /> : null}

          {transportMode === 'ble' ? (
            bleScanDevices.length === 0 ? (
              <Text style={styles.note}>
                {connectionState === 'scanning'
                  ? 'Czekam na advertisementy BLE…'
                  : 'Brak wyników. Kliknij „Skanuj BLE”.'}
              </Text>
            ) : (
              bleScanDevices.map((device) => (
                <View key={device.id} style={styles.deviceBox}>
                  <Text style={styles.deviceName}>{bleDeviceDisplayName(device)}</Text>
                  {device.name !== null &&
                  device.localName !== null &&
                  device.name !== device.localName ? (
                    <Text style={styles.mono}>name: {device.name}</Text>
                  ) : null}
                  <Text style={styles.mono}>id: {device.id}</Text>
                  <Text style={styles.mono}>
                    RSSI: {device.rssi ?? '—'} dBm | connectable:{' '}
                    {device.isConnectable === null ? '—' : device.isConnectable ? 'yes' : 'no'}
                  </Text>
                  <Text style={styles.mono}>
                    advertised services:{' '}
                    {device.serviceUUIDs === null || device.serviceUUIDs.length === 0
                      ? '—'
                      : device.serviceUUIDs.join(', ')}
                  </Text>
                  <View style={styles.deviceButton}>
                    <Button
                      title="Połącz BLE z tym urządzeniem"
                      onPress={() => void connectSelectedBleDevice(device.id)}
                      disabled={!canConnectFromList}
                    />
                  </View>
                </View>
              ))
            )
          ) : sppScanDevices.length === 0 ? (
            <Text style={styles.note}>
              {connectionState === 'scanning'
                ? 'Czekam na wynik discovery SPP…'
                : 'Brak wyników. Najlepiej najpierw sparuj moduł w ustawieniach Androida, potem kliknij „Skanuj SPP”.'}
            </Text>
          ) : (
            sppScanDevices.map((device) => (
              <View key={device.address} style={styles.deviceBox}>
                <Text style={styles.deviceName}>{device.name}</Text>
                <Text style={styles.mono}>address: {device.address}</Text>
                <Text style={styles.mono}>
                  bonded: {device.bonded ? 'yes' : 'no'} | type: {device.type} | RSSI:{' '}
                  {device.rssi ?? '—'} dBm
                </Text>
                <View style={styles.deviceButton}>
                  <Button
                    title="Połącz SPP z tym urządzeniem"
                    onPress={() => void connectSelectedSppDevice(device.address)}
                    disabled={!canConnectFromList}
                  />
                </View>
              </View>
            ))
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Transport</Text>
          <Text style={styles.mono}>czas: {formatNumber(stats.elapsedSeconds, 1)} s</Text>
          <Text style={styles.mono}>
            {eventLabel}: {stats.notifications} | avg{' '}
            {formatNumber(stats.notificationsPerSecondAverage, 2)}/s | last 1s{' '}
            {stats.notificationsPerSecond1s}/s
          </Text>
          <Text style={styles.mono}>
            bytes: {stats.bytes} | avg {formatNumber(stats.bytesPerSecondAverage, 1)} B/s | last 1s{' '}
            {stats.bytesPerSecond1s} B/s
          </Text>
          <Text style={styles.mono}>
            valid frames: {stats.validFrames} | avg{' '}
            {formatNumber(stats.validFramesPerSecondAverage, 2)}/s | last 1s{' '}
            {stats.validFramesPerSecond1s}/s
          </Text>
          <Text style={styles.mono}>length histogram: {histogramText}</Text>
          <Text style={styles.mono}>active channel IDs: {stats.channelCounts.length}</Text>
          <Text style={styles.mono}>
            callback gaps [ms]: {formatDistribution(stats.notificationGapMs)}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Integralność parsera</Text>
          <Text style={styles.mono}>transport decode errors: {transportDecodeErrors}</Text>
          <Text style={styles.mono}>checksum errors: {stats.checksumErrors}</Text>
          <Text style={styles.mono}>resync dropped bytes: {stats.markerResyncDrops}</Text>
          <Text style={styles.mono}>carry bytes: {stats.carryBytes}</Text>
          <Text style={styles.mono}>
            chunk len % 5 != 0: {stats.notificationLengthsNotMultipleOf5}
          </Text>
          <Text style={styles.mono}>
            exact consecutive duplicate chunks: {stats.exactConsecutiveDuplicateNotifications}
          </Text>
          {transportMode === 'spp' ? (
            <Text style={styles.note}>
              W SPP granice callbacków są dowolne, dlatego długość niepodzielna przez 5 jest normalna. Parser zachowuje końcówkę i łączy ją z następnym callbackiem.
            </Text>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Kanały kontrolne</Text>
          <ChannelRow label="RPM" value={stats.rpm} />
          <ChannelRow label="IAT" value={stats.iat} />
          <ChannelRow label="CLT" value={stats.clt} />
          <Text style={styles.mono}>RPM / CLT = {formatNumber(stats.rpmToCltRatio, 3)}</Text>
          <Text style={styles.mono}>IAT / CLT = {formatNumber(stats.iatToCltRatio, 3)}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Obciążenie aplikacji</Text>
          <Text style={styles.mono}>
            {callbackLabel} [ms]: {formatDistribution(stats.callbackDurationMs)}
          </Text>
          <Text style={styles.mono}>
            JS event-loop lag [ms]: {formatDistribution(stats.jsEventLoopLagMs)}
          </Text>
          <Text style={styles.note}>
            UI odświeża się tylko 2 razy/s. Callback odbiorczy wyłącznie dekoduje dane, aktualizuje liczniki i wraca — bez logowania, zapisu pliku i setState dla każdej ramki.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Założenia testu</Text>
          {transportMode === 'ble' ? (
            <>
              <Text style={styles.mono}>transport: BLE/GATT notifications</Text>
              <Text style={styles.mono}>scan filter: NONE</Text>
              <Text style={styles.mono}>scan mode: LowLatency</Text>
              <Text style={styles.mono}>requested MTU: {BLE_CONFIG.requestedMtu}</Text>
              <Text style={styles.mono}>connection priority: HIGH</Text>
            </>
          ) : (
            <>
              <Text style={styles.mono}>transport: Bluetooth Classic SPP/RFCOMM</Text>
              <Text style={styles.mono}>connection type: binary</Text>
              <Text style={styles.mono}>READ_SIZE: {SPP_READ_SIZE}</Text>
              <Text style={styles.mono}>READ_TIMEOUT: 0</Text>
              <Text style={styles.mono}>secure socket with insecure fallback</Text>
              <Text style={styles.mono}>RX bridge encoding: {classicRxEncoding}</Text>
            </>
          )}
          <Text style={styles.mono}>
            expected: RPM {BLE_CONFIG.expectedRatesHz.rpm} Hz, IAT/CLT{' '}
            {BLE_CONFIG.expectedRatesHz.clt} Hz
          </Text>
          <Text style={styles.note}>
            „rate vs nominal” jest estymacją z deklarowanych częstotliwości. Bez licznika sekwencyjnego w protokole nie da się bezpośrednio policzyć utraconych pakietów.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f2f3f5',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0,
  },
  container: {
    padding: 14,
    paddingBottom: 40,
    gap: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111827',
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: '#374151',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 2,
    color: '#111827',
  },
  status: {
    fontWeight: '700',
    textTransform: 'uppercase',
    color: '#111827',
  },
  bodyText: {
    color: '#111827',
  },
  spinner: {
    marginVertical: 6,
  },
  error: {
    color: '#b00020',
    fontWeight: '600',
  },
  infoBlock: {
    marginTop: 4,
    gap: 2,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  buttonCell: {
    flex: 1,
  },
  singleButtonRow: {
    marginTop: 6,
  },
  transportRow: {
    flexDirection: 'row',
    gap: 8,
  },
  transportButton: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#9ca3af',
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
  },
  transportSelected: {
    backgroundColor: '#2196f3',
    borderColor: '#2196f3',
  },
  transportText: {
    fontWeight: '700',
    color: '#111827',
  },
  transportSelectedText: {
    color: '#ffffff',
  },
  disabledControl: {
    opacity: 0.5,
  },
  mono: {
    fontFamily: Platform.select({ android: 'monospace', default: 'Courier' }),
    fontSize: 12,
    lineHeight: 18,
    color: '#111827',
  },
  channelBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#c7c7c7',
    borderRadius: 6,
    padding: 8,
    marginVertical: 2,
  },
  channelTitle: {
    fontWeight: '700',
    marginBottom: 2,
    color: '#111827',
  },
  deviceBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#c7c7c7',
    borderRadius: 8,
    padding: 10,
    marginTop: 6,
    gap: 2,
  },
  deviceName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  deviceButton: {
    marginTop: 6,
  },
  note: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 17,
    color: '#4a4a4a',
  },
});
