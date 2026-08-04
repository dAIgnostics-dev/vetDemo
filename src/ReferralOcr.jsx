import React, { useRef, useState } from 'react';
import { generateClient } from 'aws-amplify/data';
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  Plus,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  Trash2
} from 'lucide-react';
import { translations } from './translations';
import {
  LOW_CONFIDENCE_THRESHOLD,
  REFERRAL_SECTIONS,
  emptyExtraField,
  emptyReferral
} from './referralSchema';
import {
  normaliseExtraction,
  validateExtraFields,
  validateReferral
} from './referralValidation';
import { processPdfFile } from './pdfUtils';

const client = generateClient();

// AppSync returns AWSJSON as a string on some client versions and as a parsed
// object on others, so accept both rather than depending on the shape.
function parseExtraction(data) {
  if (!data) return null;
  return typeof data === 'string' ? JSON.parse(data) : data;
}

function mapExtraFields(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => ({
    id: crypto.randomUUID(),
    label: item?.label ?? '',
    value: item?.value ?? '',
    confidence: typeof item?.confidence === 'number' ? item.confidence : 1
  }));
}

export default function ReferralOcr({ lang }) {
  const t = key => translations[lang][key] || key;
  const fileInputRef = useRef(null);

  const [doc, setDoc] = useState(null);
  const [values, setValues] = useState(null);
  const [extraFields, setExtraFields] = useState([]);
  const [confidence, setConfidence] = useState({});
  const [warnings, setWarnings] = useState([]);
  const [meta, setMeta] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const errors = values ? validateReferral(values) : {};
  const extraErrors = validateExtraFields(extraFields);
  const hasErrors =
    Object.keys(errors).length > 0 || Object.keys(extraErrors).length > 0;

  const handleFile = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setError(t('ref_err_not_pdf'));
      return;
    }

    setStatus('loading');
    setError('');
    setConfirmed(false);
    setValues(null);
    setExtraFields([]);
    setConfidence({});
    setWarnings([]);
    setMeta(null);

    try {
      const processed = await processPdfFile(file);
      setDoc({ ...processed, fileName: file.name });
      setStatus('ready');
    } catch (err) {
      console.error('PDF processing failed:', err);
      setDoc(null);
      setStatus('idle');
      setError(`${t('ref_err_pdf')} ${err.message || ''}`.trim());
    }
  };

  const runExtraction = async () => {
    if (!doc) return;

    setStatus('extracting');
    setError('');
    setConfirmed(false);

    try {
      const { data, errors: gqlErrors } = await client.mutations.extractReferral({
        imageBase64: doc.imageBase64,
        pdfText: doc.pdfText || undefined
      });

      if (gqlErrors?.length) {
        throw new Error(gqlErrors[0].message);
      }

      const result = parseExtraction(data);
      if (!result?.canonical) {
        throw new Error('Empty response');
      }

      setValues(normaliseExtraction({ ...emptyReferral(), ...result.canonical }));
      setExtraFields(mapExtraFields(result.extraFields));
      setConfidence(result.confidence || {});
      setWarnings(result.warnings || []);
      setMeta({ ocrSource: result.ocrSource, modelId: result.modelId });
      setStatus('ready');
    } catch (err) {
      console.error('Extraction failed:', err);
      setStatus('ready');
      setError(`${t('ref_err_extract')}: ${err.message || 'unknown error'}`);
    }
  };

  const setField = (name, value) => {
    setValues(current => ({ ...current, [name]: value }));
    setConfirmed(false);
    setConfidence(current => ({ ...current, [name]: 1 }));
  };

  const updateExtraField = (id, patch) => {
    setExtraFields(current =>
      current.map(field => (field.id === id ? { ...field, ...patch, confidence: 1 } : field))
    );
    setConfirmed(false);
  };

  const addExtraField = () => {
    setExtraFields(current => [...current, emptyExtraField()]);
    setConfirmed(false);
  };

  const removeExtraField = id => {
    setExtraFields(current => current.filter(field => field.id !== id));
    setConfirmed(false);
  };

  const reset = () => {
    setDoc(null);
    setValues(null);
    setExtraFields([]);
    setConfidence({});
    setWarnings([]);
    setMeta(null);
    setError('');
    setConfirmed(false);
    setStatus('idle');
  };

  const busy = status === 'loading' || status === 'extracting';

  return (
    <div className="referral-layout">
      <section className="card referral-preview">
        <div className="referral-card-head">
          <h3><ScanLine size={20} /> {t('ref_preview')}</h3>
          <div className="actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              <FileUp size={16} /> {doc ? t('ref_replace_pdf') : t('ref_choose_pdf')}
            </button>
            {doc && (
              <button className="btn btn-ghost btn-sm" onClick={reset} disabled={busy}>
                <RotateCcw size={16} /> {t('ref_reset')}
              </button>
            )}
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          onChange={handleFile}
          style={{ display: 'none' }}
        />

        {doc ? (
          <>
            <img className="referral-page" src={doc.previewUrl} alt={doc.fileName} />
            <div className="referral-notes">
              <span>{doc.fileName}</span>
              {doc.pageCount > 1 && <span className="referral-note">{t('ref_pages_notice')}</span>}
              {doc.oversized && <span className="referral-note">{t('ref_oversized')}</span>}
            </div>
            <button
              className="btn btn-primary"
              style={{ width: '100%', marginTop: '1.25rem' }}
              onClick={runExtraction}
              disabled={busy}
            >
              {status === 'extracting'
                ? <><div className="loading-spinner" /> {t('ref_extracting')}</>
                : <><ScanLine size={18} /> {t('ref_extract')}</>}
            </button>
          </>
        ) : (
          <div className="referral-empty">
            {status === 'loading' ? (
              <><div className="loading-spinner" /> <p>{t('ref_reading_pdf')}</p></>
            ) : (
              <p>{t('ref_no_preview')}</p>
            )}
          </div>
        )}

        {error && (
          <p className="referral-error-banner">
            <AlertTriangle size={16} /> {error}
          </p>
        )}
      </section>

      <section className="card referral-form">
        <div className="referral-card-head">
          <h3><ShieldCheck size={20} /> {t('ref_form')}</h3>
          {meta && (
            <span className="referral-badge-source">
              {t('ref_source_label')}: {meta.ocrSource === 'textract'
                ? t('ref_source_textract')
                : t('ref_source_vision')}
            </span>
          )}
        </div>

        {!values ? (
          <p className="referral-muted">{t('ref_form_empty')}</p>
        ) : (
          <>
            {meta?.ocrSource === 'vision' && (
              <p className="referral-info-banner">
                <AlertTriangle size={16} /> {t('ref_textract_unavailable')}
              </p>
            )}

            {warnings.length > 0 && (
              <div className="referral-warnings">
                <strong>{t('ref_warnings')}</strong>
                <ul>
                  {warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                </ul>
              </div>
            )}

            {REFERRAL_SECTIONS.map(section => (
              <fieldset key={section.id} className="referral-section">
                <legend>{section.label[lang]}</legend>
                {section.fields.map(field => (
                  <ReferralField
                    key={field.name}
                    field={field}
                    lang={lang}
                    t={t}
                    value={values[field.name]}
                    confidence={confidence[field.name]}
                    error={errors[field.name]}
                    onChange={setField}
                  />
                ))}
              </fieldset>
            ))}

            <fieldset className="referral-section">
              <legend>{t('ref_extra_title')}</legend>

              {extraFields.length === 0 ? (
                <p className="referral-muted" style={{ marginBottom: '1rem' }}>
                  {t('ref_extra_empty')}
                </p>
              ) : (
                extraFields.map(field => {
                  const uncertain =
                    !extraErrors[field.id] &&
                    typeof field.confidence === 'number' &&
                    field.confidence < LOW_CONFIDENCE_THRESHOLD;
                  const state = extraErrors[field.id]
                    ? 'invalid'
                    : uncertain
                      ? 'uncertain'
                      : '';

                  return (
                    <div key={field.id} className={`referral-extra-row ${state}`}>
                      <div className="referral-extra-fields">
                        <div>
                          <label className="input-label">
                            {t('ref_extra_label')}
                            {uncertain && (
                              <span className="referral-badge-check">{t('ref_check')}</span>
                            )}
                          </label>
                          <input
                            type="text"
                            value={field.label}
                            onChange={event =>
                              updateExtraField(field.id, { label: event.target.value })
                            }
                          />
                          {extraErrors[field.id] && (
                            <span className="referral-field-error">
                              {t(extraErrors[field.id])}
                            </span>
                          )}
                        </div>
                        <div>
                          <label className="input-label">{t('ref_extra_value')}</label>
                          <textarea
                            className="details-textarea"
                            value={field.value ?? ''}
                            onChange={event =>
                              updateExtraField(field.id, {
                                value: event.target.value || null
                              })
                            }
                          />
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => removeExtraField(field.id)}
                        title={t('ref_extra_remove')}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  );
                })
              )}

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={addExtraField}
              >
                <Plus size={16} /> {t('ref_extra_add')}
              </button>
            </fieldset>

            {hasErrors && (
              <p className="referral-error-banner">
                <AlertTriangle size={16} /> {t('ref_invalid_count')}
              </p>
            )}

            {confirmed ? (
              <p className="referral-success-banner">
                <CheckCircle2 size={16} /> {t('ref_confirmed')}
              </p>
            ) : (
              <button
                className="btn btn-primary"
                style={{ width: '100%', marginTop: '1.5rem' }}
                onClick={() => setConfirmed(true)}
                disabled={hasErrors}
              >
                <CheckCircle2 size={18} /> {t('ref_confirm')}
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function ReferralField({ field, lang, t, value, confidence, error, onChange }) {
  const uncertain = !error && typeof confidence === 'number' && confidence < LOW_CONFIDENCE_THRESHOLD;
  const state = error ? 'invalid' : uncertain ? 'uncertain' : '';

  return (
    <div className={`referral-field ${state}`}>
      <label className="input-label" htmlFor={`ref-${field.name}`}>
        {field.label[lang]}
        {uncertain && <span className="referral-badge-check">{t('ref_check')}</span>}
      </label>

      <FieldControl
        field={field}
        lang={lang}
        t={t}
        value={value}
        onChange={onChange}
      />

      {error && <span className="referral-field-error">{t(error)}</span>}
    </div>
  );
}

function FieldControl({ field, lang, t, value, onChange }) {
  const id = `ref-${field.name}`;

  if (field.type === 'enum') {
    return (
      <select
        id={id}
        className="referral-select"
        value={value ?? ''}
        onChange={event => onChange(field.name, event.target.value || null)}
      >
        <option value="">{t('ref_unset')}</option>
        {field.options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label[lang]}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === 'textarea') {
    return (
      <textarea
        id={id}
        className="details-textarea"
        value={value ?? ''}
        onChange={event => onChange(field.name, event.target.value || null)}
      />
    );
  }

  if (field.type === 'date') {
    return (
      <input
        id={id}
        type="date"
        className="referral-date"
        value={value ?? ''}
        onChange={event => onChange(field.name, event.target.value || null)}
      />
    );
  }

  return (
    <input
      id={id}
      type="text"
      value={value ?? ''}
      onChange={event => onChange(field.name, event.target.value || null)}
    />
  );
}
