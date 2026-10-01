function addCalendarMonths(startMillis, months) {
  if (!Number.isFinite(startMillis) || !Number.isInteger(months) || months < 1 || months > 120) {
    throw new RangeError("A finite start time and 1–120 validity months are required.");
  }
  const result = new Date(startMillis);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
  return result.getTime();
}

module.exports = { addCalendarMonths };
