import { BLE_CONFIG, CHANNEL_IDS } from './config';

const GAP_SAMPLE_CAPACITY = 4096;
const CALLBACK_SAMPLE_CAPACITY = 2048;
const JS_LAG_SAMPLE_CAPACITY = 2048;
const RECENT_RATE_WINDOW_MS = 5000;
const SHORT_RATE_WINDOW_MS = 1000;

class NumberRing {
  private readonly values: Float64Array;
  private nextIndex = 0;
  private count = 0;

  constructor(capacity: number) {
    this.values = new Float64Array(capacity);
  }

  reset(): void {
    this.nextIndex = 0;
    this.count = 0;
  }

  push(value: number): void {
    this.values[this.nextIndex] = value;
    this.nextIndex = (this.nextIndex + 1) % this.values.length;
    this.count = Math.min(this.count + 1, this.values.length);
  }

  toArray(): number[] {
    const result = new Array<number>(this.count);
    if (this.count < this.values.length) {
      for (let i = 0; i < this.count; i += 1) {
        result[i] = this.values[i] ?? 0;
      }
      return result;
    }

    for (let i = 0; i < this.count; i += 1) {
      const sourceIndex = (this.nextIndex + i) % this.values.length;
      result[i] = this.values[sourceIndex] ?? 0;
    }
    return result;
  }
}

interface RecentNotification {
  timestampMs: number;
  bytes: number;
  validFrames: number;
}

export interface DistributionSnapshot {
  min: number | null;
  median: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface ChannelStatsSnapshot {
  id: number;
  count: number;
  averageRateHz: number;
  recentRateHz: number;
  expectedRateHz: number;
  estimatedDeliveryPercent: number;
  latestRaw: number | null;
  lastSeenAgoMs: number | null;
}

export interface BleStatsSnapshot {
  elapsedSeconds: number;

  notifications: number;
  notificationsPerSecondAverage: number;
  notificationsPerSecond1s: number;
  bytes: number;
  bytesPerSecondAverage: number;
  bytesPerSecond1s: number;

  validFrames: number;
  validFramesPerSecondAverage: number;
  validFramesPerSecond1s: number;
  checksumErrors: number;
  markerResyncDrops: number;
  carryBytes: number;
  notificationLengthsNotMultipleOf5: number;

  exactConsecutiveDuplicateNotifications: number;
  notificationLengthHistogram: ReadonlyArray<readonly [number, number]>;
  channelCounts: ReadonlyArray<readonly [number, number]>;
  notificationGapMs: DistributionSnapshot;
  callbackDurationMs: DistributionSnapshot;
  jsEventLoopLagMs: DistributionSnapshot;

  rpm: ChannelStatsSnapshot;
  iat: ChannelStatsSnapshot;
  clt: ChannelStatsSnapshot;
  rpmToCltRatio: number | null;
  iatToCltRatio: number | null;
}

function percentile(sortedValues: number[], fraction: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * fraction) - 1),
  );
  return sortedValues[index] ?? null;
}

function distribution(values: number[]): DistributionSnapshot {
  if (values.length === 0) {
    return { min: null, median: null, p95: null, p99: null, max: null };
  }
  values.sort((a, b) => a - b);
  return {
    min: values[0] ?? null,
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values[values.length - 1] ?? null,
  };
}

function payloadsEqual(a: Uint8Array | null, b: Uint8Array): boolean {
  if (a === null || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < b.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export class BleStatsCollector {
  private startedAtMs = 0;
  private lastNotificationAtMs: number | null = null;

  private notifications = 0;
  private bytes = 0;
  private validFrames = 0;
  private checksumErrors = 0;
  private markerResyncDrops = 0;
  private notificationLengthsNotMultipleOf5 = 0;
  private exactConsecutiveDuplicateNotifications = 0;

  private carry = new Uint8Array(0);
  private previousPayload: Uint8Array | null = null;

  private readonly channelCounts = new Float64Array(256);
  private readonly channelLatestRaw = new Int32Array(256);
  private readonly channelHasRaw = new Uint8Array(256);
  private readonly channelLastSeenMs = new Float64Array(256);

  private readonly lengthHistogram = new Map<number, number>();
  private readonly notificationGaps = new NumberRing(GAP_SAMPLE_CAPACITY);
  private readonly callbackDurations = new NumberRing(CALLBACK_SAMPLE_CAPACITY);
  private readonly jsEventLoopLags = new NumberRing(JS_LAG_SAMPLE_CAPACITY);

  private recentNotifications: RecentNotification[] = [];
  private recentRpmTimesMs: number[] = [];
  private recentIatTimesMs: number[] = [];
  private recentCltTimesMs: number[] = [];

  reset(nowMs: number): void {
    this.startedAtMs = nowMs;
    this.lastNotificationAtMs = null;

    this.notifications = 0;
    this.bytes = 0;
    this.validFrames = 0;
    this.checksumErrors = 0;
    this.markerResyncDrops = 0;
    this.notificationLengthsNotMultipleOf5 = 0;
    this.exactConsecutiveDuplicateNotifications = 0;

    this.carry = new Uint8Array(0);
    this.previousPayload = null;

    this.channelCounts.fill(0);
    this.channelLatestRaw.fill(0);
    this.channelHasRaw.fill(0);
    this.channelLastSeenMs.fill(0);

    this.lengthHistogram.clear();
    this.notificationGaps.reset();
    this.callbackDurations.reset();
    this.jsEventLoopLags.reset();

    this.recentNotifications = [];
    this.recentRpmTimesMs = [];
    this.recentIatTimesMs = [];
    this.recentCltTimesMs = [];
  }

  recordCallbackDuration(durationMs: number): void {
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      this.callbackDurations.push(durationMs);
    }
  }

  recordJsEventLoopLag(lagMs: number): void {
    if (Number.isFinite(lagMs) && lagMs >= 0) {
      this.jsEventLoopLags.push(lagMs);
    }
  }

  ingestNotification(payload: Uint8Array, nowMs: number): void {
    if (this.startedAtMs === 0) {
      this.startedAtMs = nowMs;
    }

    this.notifications += 1;
    this.bytes += payload.length;
    this.lengthHistogram.set(
      payload.length,
      (this.lengthHistogram.get(payload.length) ?? 0) + 1,
    );

    if (payload.length % 5 !== 0) {
      this.notificationLengthsNotMultipleOf5 += 1;
    }

    if (this.lastNotificationAtMs !== null) {
      this.notificationGaps.push(Math.max(0, nowMs - this.lastNotificationAtMs));
    }
    this.lastNotificationAtMs = nowMs;

    if (payloadsEqual(this.previousPayload, payload)) {
      this.exactConsecutiveDuplicateNotifications += 1;
    }
    this.previousPayload = payload.slice();

    const combined = new Uint8Array(this.carry.length + payload.length);
    combined.set(this.carry, 0);
    combined.set(payload, this.carry.length);

    let offset = 0;
    let framesFromThisCallback = 0;

    while (combined.length - offset >= 5) {
      const id = combined[offset] ?? 0;
      const marker = combined[offset + 1] ?? 0;
      const high = combined[offset + 2] ?? 0;
      const low = combined[offset + 3] ?? 0;
      const checksum = combined[offset + 4] ?? 0;

      if (marker !== 163) {
        this.markerResyncDrops += 1;
        offset += 1;
        continue;
      }

      const expectedChecksum = (id + marker + high + low) & 0xff;
      if (checksum !== expectedChecksum) {
        this.checksumErrors += 1;
        offset += 1;
        continue;
      }

      const raw = (high << 8) | low;
      this.validFrames += 1;
      framesFromThisCallback += 1;
      this.channelCounts[id] = (this.channelCounts[id] ?? 0) + 1;
      this.channelLatestRaw[id] = raw;
      this.channelHasRaw[id] = 1;
      this.channelLastSeenMs[id] = nowMs;

      if (id === CHANNEL_IDS.rpm) {
        this.recentRpmTimesMs.push(nowMs);
      } else if (id === CHANNEL_IDS.iat) {
        this.recentIatTimesMs.push(nowMs);
      } else if (id === CHANNEL_IDS.clt) {
        this.recentCltTimesMs.push(nowMs);
      }

      offset += 5;
    }

    this.carry = combined.slice(offset);
    this.recentNotifications.push({
      timestampMs: nowMs,
      bytes: payload.length,
      validFrames: framesFromThisCallback,
    });

    this.pruneRecent(nowMs);
  }

  private pruneRecent(nowMs: number): void {
    const notificationCutoff = nowMs - SHORT_RATE_WINDOW_MS;
    let firstValidNotification = 0;
    while (
      firstValidNotification < this.recentNotifications.length &&
      (this.recentNotifications[firstValidNotification]?.timestampMs ?? nowMs) < notificationCutoff
    ) {
      firstValidNotification += 1;
    }
    if (firstValidNotification > 0) {
      this.recentNotifications = this.recentNotifications.slice(firstValidNotification);
    }

    const channelCutoff = nowMs - RECENT_RATE_WINDOW_MS;
    this.recentRpmTimesMs = this.recentRpmTimesMs.filter((t) => t >= channelCutoff);
    this.recentIatTimesMs = this.recentIatTimesMs.filter((t) => t >= channelCutoff);
    this.recentCltTimesMs = this.recentCltTimesMs.filter((t) => t >= channelCutoff);
  }

  private channelSnapshot(
    id: number,
    expectedRateHz: number,
    recentTimes: number[],
    nowMs: number,
    elapsedSeconds: number,
  ): ChannelStatsSnapshot {
    const count = this.channelCounts[id] ?? 0;
    const recentWindowSeconds = Math.max(
      0.001,
      Math.min(RECENT_RATE_WINDOW_MS / 1000, elapsedSeconds),
    );
    const expectedCount = expectedRateHz * elapsedSeconds;
    const latestRaw = this.channelHasRaw[id] === 1 ? this.channelLatestRaw[id] ?? 0 : null;
    const lastSeenAgoMs =
      this.channelHasRaw[id] === 1
        ? Math.max(0, nowMs - (this.channelLastSeenMs[id] ?? nowMs))
        : null;

    return {
      id,
      count,
      averageRateHz: count / elapsedSeconds,
      recentRateHz: recentTimes.length / recentWindowSeconds,
      expectedRateHz,
      estimatedDeliveryPercent: expectedCount > 0 ? (count / expectedCount) * 100 : 0,
      latestRaw,
      lastSeenAgoMs,
    };
  }

  snapshot(nowMs: number): BleStatsSnapshot {
    this.pruneRecent(nowMs);

    const elapsedSeconds = Math.max(0.001, (nowMs - this.startedAtMs) / 1000);
    const bytes1s = this.recentNotifications.reduce((sum, item) => sum + item.bytes, 0);
    const frames1s = this.recentNotifications.reduce(
      (sum, item) => sum + item.validFrames,
      0,
    );

    const rpm = this.channelSnapshot(
      CHANNEL_IDS.rpm,
      BLE_CONFIG.expectedRatesHz.rpm,
      this.recentRpmTimesMs,
      nowMs,
      elapsedSeconds,
    );
    const iat = this.channelSnapshot(
      CHANNEL_IDS.iat,
      BLE_CONFIG.expectedRatesHz.iat,
      this.recentIatTimesMs,
      nowMs,
      elapsedSeconds,
    );
    const clt = this.channelSnapshot(
      CHANNEL_IDS.clt,
      BLE_CONFIG.expectedRatesHz.clt,
      this.recentCltTimesMs,
      nowMs,
      elapsedSeconds,
    );

    const channelCounts: Array<readonly [number, number]> = [];
    for (let id = 0; id < this.channelCounts.length; id += 1) {
      const count = this.channelCounts[id] ?? 0;
      if (count > 0) {
        channelCounts.push([id, count] as const);
      }
    }

    return {
      elapsedSeconds,

      notifications: this.notifications,
      notificationsPerSecondAverage: this.notifications / elapsedSeconds,
      notificationsPerSecond1s: this.recentNotifications.length,
      bytes: this.bytes,
      bytesPerSecondAverage: this.bytes / elapsedSeconds,
      bytesPerSecond1s: bytes1s,

      validFrames: this.validFrames,
      validFramesPerSecondAverage: this.validFrames / elapsedSeconds,
      validFramesPerSecond1s: frames1s,
      checksumErrors: this.checksumErrors,
      markerResyncDrops: this.markerResyncDrops,
      carryBytes: this.carry.length,
      notificationLengthsNotMultipleOf5: this.notificationLengthsNotMultipleOf5,

      exactConsecutiveDuplicateNotifications: this.exactConsecutiveDuplicateNotifications,
      notificationLengthHistogram: [...this.lengthHistogram.entries()].sort(
        ([lengthA], [lengthB]) => lengthA - lengthB,
      ),
      channelCounts,
      notificationGapMs: distribution(this.notificationGaps.toArray()),
      callbackDurationMs: distribution(this.callbackDurations.toArray()),
      jsEventLoopLagMs: distribution(this.jsEventLoopLags.toArray()),

      rpm,
      iat,
      clt,
      rpmToCltRatio: clt.count > 0 ? rpm.count / clt.count : null,
      iatToCltRatio: clt.count > 0 ? iat.count / clt.count : null,
    };
  }
}
