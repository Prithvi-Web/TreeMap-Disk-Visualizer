import { platform } from '../platform';
import { capabilityState } from '../platform/capabilities';
import { SmartInfo } from '../platform/types';
import { getForecast } from './forecast';
import { ForecastResult } from '../models/types';

/**
 * driveHealthMonitor — SMART attributes, correlated with the growth forecast
 * (§C4).
 *
 * **The rule that governs every line here: report, never editorialise.** A
 * false "your drive is dying" is a serious harm — it sends people to buy
 * hardware they do not need, or to panic-copy data and make mistakes doing it.
 * So this surfaces the drive's own numbers and its own self-assessment
 * verbatim, adds the arithmetic the user cannot do in their head, and stops.
 * There is no "healthy"/"failing" verdict of TreeMap's own invention.
 *
 * The two facts worth putting side by side are "space runs out in N months" and
 * "the drive has used M% of its rated writes". Either alone is a number; the
 * pair is a decision — buy a bigger drive, or buy a new one.
 *
 * `smartctl` is optional, not bundled. When it is missing the platform layer
 * already reports the reason and the install command, and that is passed
 * through unchanged: an honest can't-know beats a silent blank.
 */

export interface DriveHealthOutlook {
  /** Days until the volume is full, from the existing forecast. */
  spaceFullInDays: number | null;
  /**
   * Days until the drive reaches 100% of its rated write endurance, projected
   * from wear-so-far over power-on time. Null unless BOTH are reported.
   */
  wearExhaustedInDays: number | null;
  /** Which limit arrives first, when both are known. */
  firstLimit: 'space' | 'wear' | null;
  /** One plain-English sentence stating the two figures. Never a verdict. */
  summary: string;
}

export interface DriveHealthResult {
  available: boolean;
  /** Why SMART could not be read, including how to install the tool. */
  reason?: string;
  mechanism: string;
  devicePath: string | null;
  smart: SmartInfo | null;
  forecast: ForecastResult | null;
  outlook: DriveHealthOutlook | null;
}

const DAY_MS = 86_400_000;

/**
 * Project when write endurance runs out.
 *
 * `percentageUsed` is the NVMe/SSD wear indicator: 0 at manufacture, 100 at the
 * rated endurance. Combined with power-on hours it gives a wear rate. Null
 * unless both are present and the drive has actually worn measurably — dividing
 * by a zero wear rate would produce "never", stated with false confidence.
 */
export function projectWearExhaustion(smart: SmartInfo): number | null {
  const used = smart.percentageUsed;
  const hours = smart.powerOnHours;
  if (used === null || hours === null) return null;
  if (used <= 0 || hours <= 0) return null;
  const remaining = 100 - used;
  if (remaining <= 0) return 0;
  const percentPerHour = used / hours;
  if (!Number.isFinite(percentPerHour) || percentPerHour <= 0) return null;
  return Math.round((remaining / percentPerHour) / 24);
}

/** Whole months, for a sentence a person reads rather than computes. */
function months(days: number): string {
  if (days < 45) return `${Math.max(1, Math.round(days))} days`;
  const m = Math.round(days / 30.44);
  if (m < 24) return `${m} month${m === 1 ? '' : 's'}`;
  return `${(days / 365.25).toFixed(1)} years`;
}

export function buildOutlook(smart: SmartInfo | null, forecast: ForecastResult | null): DriveHealthOutlook {
  const spaceFullInDays = forecast && forecast.status === 'ok' && typeof forecast.fullInDays === 'number'
    ? forecast.fullInDays
    : null;
  const wearExhaustedInDays = smart ? projectWearExhaustion(smart) : null;

  let firstLimit: 'space' | 'wear' | null = null;
  if (spaceFullInDays !== null && wearExhaustedInDays !== null) {
    firstLimit = spaceFullInDays <= wearExhaustedInDays ? 'space' : 'wear';
  }

  let summary: string;
  if (spaceFullInDays !== null && wearExhaustedInDays !== null) {
    summary = firstLimit === 'space'
      ? `At the current rate this drive runs out of space in about ${months(spaceFullInDays)}. Its own wear indicator projects the rated write endurance lasting about ${months(wearExhaustedInDays)} — so space is the limit you reach first.`
      : `At the current rate this drive runs out of space in about ${months(spaceFullInDays)}, but its own wear indicator projects the rated write endurance being reached in about ${months(wearExhaustedInDays)} — the wear limit arrives first.`;
  } else if (spaceFullInDays !== null) {
    summary = `At the current rate this drive runs out of space in about ${months(spaceFullInDays)}. The drive reports no wear indicator, so there is nothing to compare that against.`;
  } else if (wearExhaustedInDays !== null) {
    summary = `The drive's wear indicator projects the rated write endurance being reached in about ${months(wearExhaustedInDays)}. There is not enough scan history yet to project when space runs out.`;
  } else {
    summary = 'Neither figure can be projected yet: the drive reports no wear indicator, and there is not enough scan history to project when space runs out.';
  }

  return { spaceFullInDays, wearExhaustedInDays, firstLimit, summary };
}

/**
 * Health for one device. `devicePath` is the raw device (`/dev/disk0`); when it
 * is omitted only the forecast half is answered, which is still useful and is
 * what a machine without smartctl gets.
 */
export async function getDriveHealth(devicePath: string | null, rootPath: string | null): Promise<DriveHealthResult> {
  const state = await capabilityState('smartData');
  const forecast = rootPath ? await getForecast(rootPath).catch(() => null) : null;

  if (!state.available || !devicePath) {
    return {
      available: false,
      reason: !state.available
        ? state.reason
        : 'No drive was named, so there is nothing to read SMART data from.',
      mechanism: state.mechanism,
      devicePath: devicePath ?? null,
      smart: null,
      forecast,
      outlook: buildOutlook(null, forecast),
    };
  }

  const smart = await platform().getSmartData(devicePath).catch(() => null);
  if (!smart) {
    return {
      available: false,
      // Many USB enclosures do not pass SMART through, and VMs have no drive to
      // ask. That is a can't-know, and saying so is the whole point.
      reason: `${devicePath} did not return SMART data. Many USB enclosures do not pass it through, and virtual machines have no physical drive to ask.`,
      mechanism: state.mechanism,
      devicePath,
      smart: null,
      forecast,
      outlook: buildOutlook(null, forecast),
    };
  }

  return {
    available: true,
    mechanism: state.mechanism,
    devicePath,
    smart,
    forecast,
    outlook: buildOutlook(smart, forecast),
  };
}
