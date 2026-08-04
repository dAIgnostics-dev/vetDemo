import { REFERRAL_FIELDS } from './referralSchema';

// ISO 7064 MOD 11,10. This is the single most useful check in the whole module:
// an OCR slip in any digit of the OIB almost always breaks the checksum.
export function isValidOib(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length !== 11) return false;

  let remainder = 10;
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder + Number(digits[i])) % 10;
    if (remainder === 0) remainder = 10;
    remainder = (remainder * 2) % 11;
  }

  const control = (11 - remainder) % 10;
  return control === Number(digits[10]);
}

// ISO 11784 transponder codes are exactly 15 digits.
export function isValidMicrochip(value) {
  return /^\d{15}$/.test(String(value ?? '').replace(/[\s-]/g, ''));
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value ?? '').trim());
}

export function isValidPhone(value) {
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  return digits.length >= 6 && digits.length <= 15;
}

// Accepts the Croatian "31.12.2025." form (with or without the trailing dot),
// slash separators, and anything already in ISO. Returns ISO or null.
export function normaliseDate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return isRealDate(+iso[1], +iso[2], +iso[3]) ? raw : null;

  const local = raw.match(/^(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4})\.?$/);
  if (!local) return null;

  const day = Number(local[1]);
  const month = Number(local[2]);
  const year = Number(local[3]);
  if (!isRealDate(year, month, day)) return null;

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isRealDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const VALIDATORS = {
  oib: isValidOib,
  mikrocip: isValidMicrochip,
  email: isValidEmail,
  phone: isValidPhone,
  date: value => normaliseDate(value) !== null
};

const ERROR_KEYS = {
  oib: 'ref_err_oib',
  mikrocip: 'ref_err_microchip',
  email: 'ref_err_email',
  phone: 'ref_err_phone',
  date: 'ref_err_date'
};

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

// Returns a map of field name -> translation key. Only non-empty values are
// checked; a field the model correctly refused to guess is not an error.
export function validateReferral(values) {
  const errors = {};

  for (const field of REFERRAL_FIELDS) {
    if (!field.validate) continue;

    const value = values?.[field.name];
    if (isBlank(value)) continue;

    if (!VALIDATORS[field.validate](value)) {
      errors[field.name] = ERROR_KEYS[field.validate];
    }
  }

  return errors;
}

// Extra rows need a label whenever they carry a value (or the user started typing one).
export function validateExtraFields(extraFields) {
  const errors = {};

  for (const field of extraFields || []) {
    const labelBlank = isBlank(field.label);
    const valueBlank = isBlank(field.value);
    if (labelBlank && !valueBlank) {
      errors[field.id] = 'ref_err_extra_label';
    }
  }

  return errors;
}

// Applied once when the extraction lands, so date-like inputs get a usable value.
// `dob` stays free text and is not normalised.
export function normaliseExtraction(values) {
  const normalised = { ...values };

  for (const field of REFERRAL_FIELDS) {
    if (field.validate !== 'date') continue;

    const value = normalised[field.name];
    if (isBlank(value)) continue;

    normalised[field.name] = normaliseDate(value) ?? value;
  }

  return normalised;
}
