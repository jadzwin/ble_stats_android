import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  ScrollView,
  Share,
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

import { BleStatsCollector } from './src/BleStatsCollector';
import type {
  BleStatsSnapshot,
  ChannelStatsSnapshot,
  DistributionSnapshot,
} from './src/BleStatsCollector';
import { BLE_CONFIG } from './src/config';
import { monotonicNowMs } from './src/time';

type ConnectionState =
  | 'idle'
  | 'waiting-for-bluetooth'
  | 'scanning'
  | 'scan-results'
  | 'connecting'
  | 'discovering'
  | 'subscribing'
  | 'receiving'
  | 'disconnecting'
  | 'disconnected'
  | 'error';

interface ConnectedInfo {
  id: string;
  name: string;
  scanRssi: number | null;
  mtu: number;
  serviceUuid: string;
  notifyCharacteristicUuid: string;
  characteristicSummary: string;
  connectedAtIso: string;
}

interface ScanDeviceRow {
  id: string;
  name: string | null;
  localName: string | null;
  rssi: number | null;
  isConnectable: boolean | null;
  serviceUUIDs: string[] | null;
}

function normalizedUuid(uuid: string): string {
  return uuid.trim().toLowerCase();
}

function deviceDisplayName(device: Pick<ScanDeviceRow, 'id' | 'name' | 'localName'>): string {
  return device.localName ?? device.name ?? '(bez nazwy)';
}

function deviceToRow(device: Device): ScanDeviceRow {
  return {
    id: device.id,
    name: device.name ?? null,
    localName: device.localName ?? null,
    rssi: device.rssi ?? null,
    isConnectable: device.isConnectable ?? null,
    serviceUUIDs: device.serviceUUIDs ?? null,
  };
}

function sortDevices(rows: ScanDeviceRow[]): ScanDeviceRow[] {
  return rows.sort((a, b) => {
    const aRssi = a.rssi ?? -999;
    const bRssi = b.rssi ?? -999;
    if (aRssi !== bRssi) {
      return bRssi - aRssi;
    }
    return deviceDisplayName(a).localeCompare(deviceDisplayName(b));
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

async function waitForPoweredOn(manager: BleManager): Promise<void> {
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

function ErrorDescription(error: unknown): string {
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
  return String(error);
}

function ChannelRow({ label, value }: { label: string; value: ChannelStatsSnapshot }) {
  return (
    <View style={styles.channelBox}>
      <Text style={styles.channelTitle}>
        {label} (ID {value.id})
      </Text>
      <Text style={styles.mono}>
        count={value.count} | avg={formatNumber(value.averageRateHz, 2)} Hz | 5s={formatNumber(
          value.recentRateHz,
          2,
        )} Hz
      </Text>
      <Text style={styles.mono}>
        expected={formatNumber(value.expectedRateHz, 2)} Hz | delivery≈
        {formatNumber(value.estimatedDeliveryPercent, 1)}% | raw={value.latestRaw ?? '—'} | age=
        {formatNumber(value.lastSeenAgoMs, 0)} ms
      </Text>
    </View>
  );
}

export default function App() {
  const manager = useMemo(() => new BleManager(), []);
  const collectorRef = useRef(new BleStatsCollector());
  const monitorSubscriptionRef = useRef<Subscription | null>(null);
  const disconnectSubscriptionRef = useRef<Subscription | null>(null);
  const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanUiTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const discoveredDeviceObjectsRef = useRef<Map<string, Device>>(new Map());
  const discoveredRowsRef = useRef<Map<string, ScanDeviceRow>>(new Map());
  const connectingRef = useRef(false);
  const connectedDeviceIdRef = useRef<string | null>(null);
  const intentionalDisconnectRef = useRef(false);

  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [statusText, setStatusText] = useState(
    'Gotowy. Najpierw zeskanuj BLE, wybierz urządzenie z listy i kliknij Połącz.',
  );
  const [errorText, setErrorText] = useState<string | null>(null);
  const [connectedInfo, setConnectedInfo] = useState<ConnectedInfo | null>(null);
  const [scanDevices, setScanDevices] = useState<ScanDeviceRow[]>([]);
  const [stats, setStats] = useState<BleStatsSnapshot>(() => emptySnapshot());

  const refreshScanList = useCallback(() => {
    setScanDevices(sortDevices(Array.from(discoveredRowsRef.current.values())));
  }, []);

  const stopScan = useCallback(() => {
    if (scanTimeoutRef.current !== null) {
      clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }
    if (scanUiTimerRef.current !== null) {
      clearInterval(scanUiTimerRef.current);
      scanUiTimerRef.current = null;
    }
    void manager.stopDeviceScan().catch(() => undefined);
  }, [manager]);

  const finishScan = useCallback(
    (message?: string) => {
      stopScan();
      refreshScanList();
      setConnectionState('scan-results');
      setStatusText(
        message ??
          `Skan zakończony. Znaleziono ${discoveredRowsRef.current.size} urządzeń. Wybierz urządzenie i kliknij Połącz.`,
      );
    },
    [refreshScanList, stopScan],
  );

  const removeSubscriptions = useCallback(() => {
    monitorSubscriptionRef.current?.remove();
    monitorSubscriptionRef.current = null;
    disconnectSubscriptionRef.current?.remove();
    disconnectSubscriptionRef.current = null;
  }, []);

  const installMonitor = useCallback(
    async (device: Device, scanRssi: number | null): Promise<void> => {
      setConnectionState('discovering');
      setStatusText('Wykrywanie usług i charakterystyk…');
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
      collectorRef.current.reset(monotonicNowMs());
      setStats(emptySnapshot());

      const connectedAtIso = new Date().toISOString();
      setConnectedInfo({
        id: preparedDevice.id,
        name: preparedDevice.localName ?? preparedDevice.name ?? '(bez nazwy)',
        scanRssi,
        mtu: preparedDevice.mtu,
        serviceUuid: notifyCharacteristic.serviceUUID,
        notifyCharacteristicUuid: notifyCharacteristic.uuid,
        characteristicSummary: characteristicDescriptions.join('\n'),
        connectedAtIso,
      });

      monitorSubscriptionRef.current = preparedDevice.monitorCharacteristicForService(
        notifyCharacteristic.serviceUUID,
        notifyCharacteristic.uuid,
        (error, characteristic) => {
          const callbackStartedAt = monotonicNowMs();
          if (error !== null) {
            if (!intentionalDisconnectRef.current) {
              setErrorText(ErrorDescription(error));
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
          collectorRef.current.recordCallbackDuration(monotonicNowMs() - callbackStartedAt);
        },
        'ecumaster-rx-monitor',
      );

      disconnectSubscriptionRef.current = manager.onDeviceDisconnected(
        preparedDevice.id,
        (error) => {
          connectedDeviceIdRef.current = null;
          connectingRef.current = false;
          monitorSubscriptionRef.current?.remove();
          monitorSubscriptionRef.current = null;
          if (intentionalDisconnectRef.current) {
            setConnectionState('disconnected');
            setStatusText('Rozłączono ręcznie. Możesz ponownie uruchomić skan BLE.');
            return;
          }
          setConnectionState('disconnected');
          setStatusText('Połączenie zostało przerwane.');
          if (error !== null) {
            setErrorText(ErrorDescription(error));
          }
        },
      );

      connectingRef.current = false;
      setConnectionState('receiving');
      setStatusText('Odbieranie notyfikacji. Brak logowania per ramka i brak operacji TX.');
    },
    [manager],
  );

  const connectFoundDevice = useCallback(
    async (scannedDevice: Device): Promise<void> => {
      setConnectionState('connecting');
      setStatusText(`Łączenie z ${scannedDevice.localName ?? scannedDevice.name ?? scannedDevice.id}…`);

      let device = await scannedDevice.connect({
        autoConnect: false,
        timeout: BLE_CONFIG.connectionTimeoutMs,
      });
      connectedDeviceIdRef.current = device.id;

      try {
        device = await manager.requestConnectionPriorityForDevice(
          device.id,
          ConnectionPriority.High,
          'ecumaster-high-priority',
        );
        setStatusText('Połączono; wysłano żądanie CONNECTION_PRIORITY_HIGH.');
      } catch (error) {
        setStatusText(
          `Połączono, ale żądanie high priority zwróciło błąd: ${ErrorDescription(error)}`,
        );
      }

      try {
        device = await manager.requestMTUForDevice(
          device.id,
          BLE_CONFIG.requestedMtu,
          'ecumaster-request-mtu',
        );
        setStatusText(`High priority zażądane; MTU zwrócone przez bibliotekę: ${device.mtu}.`);
      } catch (error) {
        setStatusText(`High priority zażądane; MTU request error: ${ErrorDescription(error)}`);
      }

      await installMonitor(device, scannedDevice.rssi ?? null);
    },
    [installMonitor, manager],
  );

  const startScan = useCallback(async () => {
    if (connectingRef.current || connectedDeviceIdRef.current !== null) {
      return;
    }

    intentionalDisconnectRef.current = false;
    setErrorText(null);
    setConnectedInfo(null);
    removeSubscriptions();
    stopScan();
    discoveredDeviceObjectsRef.current.clear();
    discoveredRowsRef.current.clear();
    setScanDevices([]);

    try {
      const permissionsGranted = await requestAndroidPermissions();
      if (!permissionsGranted) {
        throw new Error('Brak uprawnień Bluetooth wymaganych do skanowania i połączenia.');
      }

      setConnectionState('waiting-for-bluetooth');
      setStatusText('Oczekiwanie na Bluetooth PoweredOn…');
      await waitForPoweredOn(manager);

      setConnectionState('scanning');
      setStatusText(
        `Skanowanie wszystkich urządzeń BLE przez ${BLE_CONFIG.scanTimeoutMs / 1000} s. Wybór urządzenia jest ręczny.`,
      );

      scanUiTimerRef.current = setInterval(() => {
        refreshScanList();
      }, 300);

      scanTimeoutRef.current = setTimeout(() => {
        finishScan();
      }, BLE_CONFIG.scanTimeoutMs);

      await manager.startDeviceScan(
        null,
        {
          scanMode: ScanMode.LowLatency,
          // Domyślny legacyScan=true jest celowo zachowany: Bolutek nadaje klasyczny advertisement.
          // Brak filtra UUID/nazwy/MAC — pokazujemy wszystko, co zwróci Android.
        },
        (error, device) => {
          if (error !== null) {
            stopScan();
            setConnectionState('error');
            setErrorText(ErrorDescription(error));
            return;
          }

          if (device === null) {
            return;
          }

          discoveredDeviceObjectsRef.current.set(device.id, device);
          discoveredRowsRef.current.set(device.id, deviceToRow(device));
        },
      );
    } catch (error) {
      stopScan();
      setConnectionState('error');
      setErrorText(ErrorDescription(error));
    }
  }, [finishScan, manager, refreshScanList, removeSubscriptions, stopScan]);

  const connectSelectedDevice = useCallback(
    async (deviceId: string) => {
      if (connectingRef.current || connectedDeviceIdRef.current !== null) {
        return;
      }

      const device = discoveredDeviceObjectsRef.current.get(deviceId);
      if (device === undefined) {
        setConnectionState('error');
        setErrorText('Wybrane urządzenie nie jest już dostępne w pamięci skanera. Uruchom skan ponownie.');
        return;
      }

      intentionalDisconnectRef.current = false;
      connectingRef.current = true;
      setErrorText(null);
      stopScan();

      try {
        await connectFoundDevice(device);
      } catch (connectError) {
        const failedDeviceId = connectedDeviceIdRef.current;
        if (failedDeviceId !== null) {
          void manager.cancelDeviceConnection(failedDeviceId).catch(() => undefined);
        }
        connectedDeviceIdRef.current = null;
        connectingRef.current = false;
        setConnectionState('error');
        setErrorText(ErrorDescription(connectError));
      }
    },
    [connectFoundDevice, manager, stopScan],
  );

  const disconnect = useCallback(async () => {
    intentionalDisconnectRef.current = true;
    stopScan();
    removeSubscriptions();
    const deviceId = connectedDeviceIdRef.current;
    connectedDeviceIdRef.current = null;
    connectingRef.current = false;
    if (deviceId === null) {
      setConnectionState('disconnected');
      setStatusText('Brak aktywnego połączenia.');
      return;
    }

    setConnectionState('disconnecting');
    try {
      await manager.cancelDeviceConnection(deviceId);
    } catch {
      // Połączenie mogło już zostać zamknięte przez system.
    }
    setConnectionState('disconnected');
    setStatusText('Rozłączono ręcznie. Możesz ponownie uruchomić skan BLE.');
  }, [manager, removeSubscriptions, stopScan]);

  const resetStats = useCallback(() => {
    collectorRef.current.reset(monotonicNowMs());
    setStats(emptySnapshot());
  }, []);

  const shareReport = useCallback(async () => {
    const report = [
      'ECUMaster BLE RX Stats v1.1',
      `generated=${new Date().toISOString()}`,
      `state=${connectionState}`,
      `status=${statusText}`,
      connectedInfo ? `connected_at=${connectedInfo.connectedAtIso}` : null,
      connectedInfo ? `device=${connectedInfo.name} ${connectedInfo.id}` : 'device=—',
      connectedInfo ? `scanRssi=${connectedInfo.scanRssi ?? '—'} dBm` : null,
      connectedInfo ? `mtu=${connectedInfo.mtu}` : null,
      connectedInfo ? `service=${connectedInfo.serviceUuid}` : null,
      connectedInfo ? `notify=${connectedInfo.notifyCharacteristicUuid}` : null,
      `elapsed_s=${stats.elapsedSeconds.toFixed(3)}`,
      `notifications=${stats.notifications}`,
      `notifications_per_s_avg=${stats.notificationsPerSecondAverage.toFixed(3)}`,
      `bytes=${stats.bytes}`,
      `bytes_per_s_avg=${stats.bytesPerSecondAverage.toFixed(3)}`,
      `frames=${stats.validFrames}`,
      `frames_per_s_avg=${stats.validFramesPerSecondAverage.toFixed(3)}`,
      `checksum_errors=${stats.checksumErrors}`,
      `resync_dropped_bytes=${stats.markerResyncDrops}`,
      `carry_bytes=${stats.carryBytes}`,
      `non_multiple_of_5_notifications=${stats.notificationLengthsNotMultipleOf5}`,
      `consecutive_exact_duplicate_notifications=${stats.exactConsecutiveDuplicateNotifications}`,
      `RPM_count=${stats.rpm.count} RPM_avg_hz=${stats.rpm.averageRateHz.toFixed(
        3,
      )} RPM_delivery_pct=${stats.rpm.estimatedDeliveryPercent.toFixed(2)}`,
      `IAT_count=${stats.iat.count} IAT_avg_hz=${stats.iat.averageRateHz.toFixed(
        3,
      )} IAT_delivery_pct=${stats.iat.estimatedDeliveryPercent.toFixed(2)}`,
      `CLT_count=${stats.clt.count} CLT_avg_hz=${stats.clt.averageRateHz.toFixed(
        3,
      )} CLT_delivery_pct=${stats.clt.estimatedDeliveryPercent.toFixed(2)}`,
      `RPM_to_CLT=${stats.rpmToCltRatio ?? '—'}`,
      `IAT_to_CLT=${stats.iatToCltRatio ?? '—'}`,
      `notification_lengths=${stats.notificationLengthHistogram
        .map(([length, count]) => `${length}:${count}`)
        .join(',')}`,
      `channel_counts=${stats.channelCounts
        .map(([id, count]) => `${id}:${count}`)
        .join(',')}`,
      `notification_gap_ms=${JSON.stringify(stats.notificationGapMs)}`,
      `callback_duration_ms=${JSON.stringify(stats.callbackDurationMs)}`,
      `js_event_loop_lag_ms=${JSON.stringify(stats.jsEventLoopLagMs)}`,
      connectedInfo ? `characteristics=\n${connectedInfo.characteristicSummary}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');

    await Share.share({ title: 'ECUMaster BLE RX Stats', message: report });
  }, [connectedInfo, connectionState, stats, statusText]);

  useEffect(() => {
    void manager.setLogLevel(LogLevel.None).catch(() => undefined);

    const uiTimer = setInterval(() => {
      setStats(collectorRef.current.snapshot(monotonicNowMs()));
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
      stopScan();
      removeSubscriptions();
      const deviceId = connectedDeviceIdRef.current;
      if (deviceId !== null) {
        void manager.cancelDeviceConnection(deviceId).catch(() => undefined);
      }
      void manager.destroy().catch(() => undefined);
    };
  }, [manager, removeSubscriptions, stopScan]);

  const isConnectionBusy = [
    'waiting-for-bluetooth',
    'connecting',
    'discovering',
    'subscribing',
    'receiving',
    'disconnecting',
  ].includes(connectionState);
  const activeConnectionNeedsDisconnect = connectionState === 'error' && connectedInfo !== null;
  const canDisconnect = isConnectionBusy || activeConnectionNeedsDisconnect;
  const canStartScan =
    !isConnectionBusy && !activeConnectionNeedsDisconnect && connectionState !== 'scanning';
  const canConnectFromList =
    !connectingRef.current && connectedDeviceIdRef.current === null && connectionState !== 'receiving';
  const histogramText =
    stats.notificationLengthHistogram.length === 0
      ? '—'
      : stats.notificationLengthHistogram
          .map(([length, count]) => `${length} B: ${count}`)
          .join(' | ');

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>ECUMaster BLE RX Stats v1.1</Text>
        <Text style={styles.subtitle}>
          Najpierw skan wszystkich urządzeń BLE, potem ręczny wybór. Po połączeniu: High connection
          priority, MTU request i test RX-only.
        </Text>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Połączenie</Text>
          <Text style={styles.status}>{connectionState}</Text>
          <Text>{statusText}</Text>
          {['waiting-for-bluetooth', 'connecting', 'discovering', 'subscribing'].includes(
            connectionState,
          ) ? (
            <ActivityIndicator style={styles.spinner} />
          ) : null}
          {errorText !== null ? <Text style={styles.error}>{errorText}</Text> : null}

          {connectedInfo !== null ? (
            <View style={styles.infoBlock}>
              <Text style={styles.mono}>device: {connectedInfo.name}</Text>
              <Text style={styles.mono}>id: {connectedInfo.id}</Text>
              <Text style={styles.mono}>scan RSSI: {connectedInfo.scanRssi ?? '—'} dBm</Text>
              <Text style={styles.mono}>MTU reported: {connectedInfo.mtu}</Text>
              <Text style={styles.mono}>service: {connectedInfo.serviceUuid}</Text>
              <Text style={styles.mono}>notify: {connectedInfo.notifyCharacteristicUuid}</Text>
            </View>
          ) : null}

          <View style={styles.buttonRow}>
            <View style={styles.buttonCell}>
              <Button title="Skanuj BLE" onPress={() => void startScan()} disabled={!canStartScan} />
            </View>
            <View style={styles.buttonCell}>
              <Button
                title="Zatrzymaj skan"
                onPress={() => finishScan('Skan zatrzymany ręcznie. Wybierz urządzenie z listy.')}
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
          <Text style={styles.sectionTitle}>Znalezione urządzenia BLE ({scanDevices.length})</Text>
          <Text style={styles.note}>
            Lista nie filtruje po nazwie, MAC ani UUID. RSSI jest z ostatniego advertisement zwróconego
            przez Androida. Najsilniejsze urządzenia są na górze.
          </Text>
          {connectionState === 'scanning' ? <ActivityIndicator style={styles.spinner} /> : null}
          {scanDevices.length === 0 ? (
            <Text style={styles.note}>
              {connectionState === 'scanning'
                ? 'Czekam na advertisementy BLE…'
                : 'Brak wyników. Kliknij „Skanuj BLE”.'}
            </Text>
          ) : (
            scanDevices.map((device) => (
              <View key={device.id} style={styles.deviceBox}>
                <Text style={styles.deviceName}>{deviceDisplayName(device)}</Text>
                {device.name !== null && device.localName !== null && device.name !== device.localName ? (
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
                    title="Połącz z tym urządzeniem"
                    onPress={() => void connectSelectedDevice(device.id)}
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
            notifications: {stats.notifications} | avg{' '}
            {formatNumber(stats.notificationsPerSecondAverage, 2)}/s | last 1s{' '}
            {stats.notificationsPerSecond1s}/s
          </Text>
          <Text style={styles.mono}>
            bytes: {stats.bytes} | avg {formatNumber(stats.bytesPerSecondAverage, 1)} B/s | last 1s{' '}
            {stats.bytesPerSecond1s} B/s
          </Text>
          <Text style={styles.mono}>
            valid frames: {stats.validFrames} | avg {formatNumber(
              stats.validFramesPerSecondAverage,
              2,
            )}/s | last 1s {stats.validFramesPerSecond1s}/s
          </Text>
          <Text style={styles.mono}>length histogram: {histogramText}</Text>
          <Text style={styles.mono}>active channel IDs: {stats.channelCounts.length}</Text>
          <Text style={styles.mono}>
            notification gaps [ms]: {formatDistribution(stats.notificationGapMs)}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Integralność parsera</Text>
          <Text style={styles.mono}>checksum errors: {stats.checksumErrors}</Text>
          <Text style={styles.mono}>resync dropped bytes: {stats.markerResyncDrops}</Text>
          <Text style={styles.mono}>carry bytes: {stats.carryBytes}</Text>
          <Text style={styles.mono}>
            notification len % 5 != 0: {stats.notificationLengthsNotMultipleOf5}
          </Text>
          <Text style={styles.mono}>
            exact consecutive duplicate notifications: {stats.exactConsecutiveDuplicateNotifications}
          </Text>
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
            BLE callback [ms]: {formatDistribution(stats.callbackDurationMs)}
          </Text>
          <Text style={styles.mono}>
            JS event-loop lag [ms]: {formatDistribution(stats.jsEventLoopLagMs)}
          </Text>
          <Text style={styles.note}>
            Po połączeniu skan jest zatrzymany. UI statystyk odświeża się tylko 2 razy/s. Callback BLE
            wyłącznie dekoduje Base64, aktualizuje liczniki i wraca — brak setState, console.log, zapisu
            pliku i operacji TX dla każdej notyfikacji.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Założenia testu</Text>
          <Text style={styles.mono}>scan filter: NONE</Text>
          <Text style={styles.mono}>scan mode: LowLatency</Text>
          <Text style={styles.mono}>device selection: manual</Text>
          <Text style={styles.mono}>requested MTU: {BLE_CONFIG.requestedMtu}</Text>
          <Text style={styles.mono}>connection priority: HIGH</Text>
          <Text style={styles.mono}>
            expected: RPM {BLE_CONFIG.expectedRatesHz.rpm} Hz, IAT/CLT{' '}
            {BLE_CONFIG.expectedRatesHz.clt} Hz
          </Text>
          <Text style={styles.note}>
            „delivery %” jest estymacją z deklarowanych częstotliwości. Bez licznika sekwencyjnego w
            protokole nie da się bezpośrednio policzyć utraconych notyfikacji.
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
  },
  container: {
    padding: 14,
    paddingBottom: 40,
    gap: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
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
  },
  status: {
    fontWeight: '700',
    textTransform: 'uppercase',
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
  mono: {
    fontFamily: Platform.select({ android: 'monospace', default: 'Courier' }),
    fontSize: 12,
    lineHeight: 18,
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
