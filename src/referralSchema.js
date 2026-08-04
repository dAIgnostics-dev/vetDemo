// Canonical referral fields shared across all form variants.
// Anything else found on a document lands in extra_fields (see ReferralOcr).

export const REFERRAL_SECTIONS = [
  {
    id: 'vlasnik',
    label: { en: 'Owner', hr: 'Vlasnik' },
    fields: [
      {
        name: 'vlasnik_ime',
        type: 'text',
        label: { en: 'First name', hr: 'Ime' }
      },
      {
        name: 'vlasnik_prezime',
        type: 'text',
        label: { en: 'Last name', hr: 'Prezime' }
      },
      {
        name: 'vlasnik_adresa',
        type: 'text',
        label: { en: 'Address', hr: 'Adresa' }
      },
      {
        name: 'vlasnik_oib',
        type: 'text',
        label: { en: 'OIB', hr: 'OIB' },
        validate: 'oib'
      }
    ]
  },
  {
    id: 'zivotinja',
    label: { en: 'Animal', hr: 'Životinja' },
    fields: [
      {
        name: 'vrsta',
        type: 'text',
        label: { en: 'Species', hr: 'Vrsta' }
      },
      {
        name: 'pasmina',
        type: 'text',
        label: { en: 'Breed', hr: 'Pasmina' }
      },
      {
        name: 'dob',
        type: 'text',
        label: { en: 'Age', hr: 'Dob' }
      },
      {
        name: 'spol',
        type: 'enum',
        label: { en: 'Sex', hr: 'Spol' },
        options: [
          { value: 'M', label: { en: 'M', hr: 'M' } },
          { value: 'Z', label: { en: 'F', hr: 'Ž' } }
        ]
      },
      {
        name: 'mikrocip',
        type: 'text',
        label: { en: 'Microchip', hr: 'Mikročip' },
        validate: 'mikrocip'
      }
    ]
  }
];

export const REFERRAL_FIELDS = REFERRAL_SECTIONS.flatMap(section => section.fields);

export const FIELD_BY_NAME = Object.fromEntries(
  REFERRAL_FIELDS.map(field => [field.name, field])
);

export function emptyReferral() {
  return Object.fromEntries(REFERRAL_FIELDS.map(field => [field.name, null]));
}

export function emptyExtraField() {
  return {
    id: crypto.randomUUID(),
    label: '',
    value: '',
    confidence: 1
  };
}

export const LOW_CONFIDENCE_THRESHOLD = 0.9;
