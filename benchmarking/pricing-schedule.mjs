// DeepSeek's published UTC peak windows exclude weekends and Chinese public
// holidays. Peak windows occur entirely within the same Chinese/UTC date.
// Holiday source: https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html
const holidays = {
  2026: [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'],
    ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']]
};
export const deepseekScheduleNote = 'Peak rates apply 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday, excluding Chinese public holidays. Each request uses its recorded timestamp. Automatic cache writes use the cache-miss input rate.';

export function scheduledPrice(price, timestamp) {
  if (!price.time_schedule) return price;
  if (price.time_schedule.kind !== 'deepseek-utc-v1') return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const day = date.getUTCDay(), minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  const window = day >= 1 && day <= 5 && (minute >= 60 && minute < 240 || minute >= 360 && minute < 600);
  const calendar = holidays[date.getUTCFullYear()], md = date.toISOString().slice(5, 10);
  const holiday = calendar?.some(([start, end]) => md >= start && md <= end);
  const peak = window && !holiday;
  return { ...price, rates: peak ? price.time_schedule.peak_rates : price.rates,
    price_period: peak ? 'peak' : 'off-peak',
    ...(window && !calendar ? { estimated: 'Chinese holiday calendar is not verified for this year; peak-window costs are upper-bound estimates.' } : {}) };
}
