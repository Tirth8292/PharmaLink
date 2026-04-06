function normalizeTimeValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const meridiemMatch = raw.match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (meridiemMatch) {
    let hours = Number(meridiemMatch[1]) % 12;
    if (meridiemMatch[3].toUpperCase() === 'PM') hours += 12;
    return `${String(hours).padStart(2, '0')}:${meridiemMatch[2]}`;
  }

  const twentyFourHourMatch = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourHourMatch) {
    return `${String(Number(twentyFourHourMatch[1])).padStart(2, '0')}:${twentyFourHourMatch[2]}`;
  }

  return raw;
}

function formatNormalizedTime(value) {
  const normalized = normalizeTimeValue(value);
  const timeMatch = normalized.match(/^(\d{2}):(\d{2})$/);
  if (!timeMatch) return String(value || '').trim();

  const hours = Number(timeMatch[1]);
  const minutes = timeMatch[2];
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${minutes} ${suffix}`;
}

export function formatTimeLabel(value) {
  return formatNormalizedTime(value);
}

export function getSlotStart(slot) {
  const startLabel = slot?.start || String(slot?.label || '').split(' - ')[0];
  return normalizeTimeValue(startLabel);
}

export function formatSlotLabel(slot) {
  const label = String(slot?.label || '').trim();
  const start = getSlotStart(slot);
  const derivedEnd = label.includes(' - ') ? label.split(' - ').slice(-1)[0] : '';
  const end = normalizeTimeValue(slot?.end || derivedEnd);

  if (start && end) return `${formatNormalizedTime(start)} - ${formatNormalizedTime(end)}`;
  if (start) return formatNormalizedTime(start);
  return label;
}

export function generateSlots(startTime, endTime, slotDuration) {
  const normalizedStartTime = normalizeTimeValue(startTime);
  const normalizedEndTime = normalizeTimeValue(endTime);
  if (!normalizedStartTime || !normalizedEndTime || !slotDuration) return [];
  const [startHours, startMinutes] = normalizedStartTime.split(':').map(Number);
  const [endHours, endMinutes] = normalizedEndTime.split(':').map(Number);
  const start = startHours * 60 + startMinutes;
  const end = endHours * 60 + endMinutes;
  const slots = [];

  for (let current = start; current + slotDuration <= end; current += slotDuration) {
    const next = current + slotDuration;
    const startLabel = `${String(Math.floor(current / 60)).padStart(2, '0')}:${String(current % 60).padStart(2, '0')}`;
    const endLabel = `${String(Math.floor(next / 60)).padStart(2, '0')}:${String(next % 60).padStart(2, '0')}`;
    slots.push({
      label: `${startLabel} - ${endLabel}`,
      start: startLabel,
      end: endLabel,
      booked: false,
      manualDisabled: false
    });
  }
  return slots;
}

export function sortDoctors(doctors, city = '') {
  const normalizedCity = city.trim().toLowerCase();
  return [...doctors].sort((a, b) => {
    const aScore = normalizedCity && a.city?.toLowerCase().includes(normalizedCity) ? 0 : 1;
    const bScore = normalizedCity && b.city?.toLowerCase().includes(normalizedCity) ? 0 : 1;
    if (aScore !== bScore) return aScore - bScore;
    if (a.is_available !== b.is_available) return a.is_available ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function getSlotState(slot) {
  if (slot.booked) return { label: 'Booked', disabled: true, classes: 'bg-slate-200 text-slate-500 cursor-not-allowed' };
  if (slot.manualDisabled) return { label: 'Disabled', disabled: true, classes: 'bg-rose-50 text-rose-600 cursor-not-allowed' };
  return { label: formatSlotLabel(slot), disabled: false, classes: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' };
}
