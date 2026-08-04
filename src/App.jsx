import React, { useState, useEffect } from 'react';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { Authenticator } from '@aws-amplify/ui-react';
import { 
  Plus, 
  Send, 
  Save, 
  Download, 
  History, 
  LogOut, 
  Stethoscope, 
  X,
  ChevronRight,
  Clock,
  FileText,
  Trash2,
  User,
  Globe,
  Lock,
  ShieldCheck,
  ScanLine
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { fetchUserAttributes, updateUserAttributes, updatePassword } from 'aws-amplify/auth';
import '@aws-amplify/ui-react/styles.css';
import outputs from '../amplify_outputs.json';
import { translations } from './translations';
import ReferralOcr from './ReferralOcr';
import './index.css';

Amplify.configure(outputs);
const client = generateClient();

function GeneratorContent({ signOut, user }) {
  const [lang, setLang] = useState(localStorage.getItem('vet_lang') || 'en');
  const [activeTab, setActiveTab] = useState('generator');
  const [details, setDetails] = useState('');
  const [keywords, setKeywords] = useState(['', '', '']);
  const [report, setReport] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [userProfile, setUserProfile] = useState({ firstName: '', lastName: '' });

  const t = (key) => translations[lang][key] || key;

  useEffect(() => {
    localStorage.setItem('vet_lang', lang);
  }, [lang]);

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      const attrs = await fetchUserAttributes();
      setUserProfile({
        firstName: attrs.given_name || '',
        lastName: attrs.family_name || ''
      });
    } catch (e) {
      console.error('Error fetching user attributes:', e);
    }
  };

  useEffect(() => {
    if (showHistory) {
      fetchHistory();
    }
  }, [showHistory]);

  const fetchHistory = async () => {
    setLoadingHistory(true);
    try {
      const { data } = await client.models.Diagnosis.list();
      setHistory(data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    } catch (error) {
      console.error('Error fetching history:', error);
    } finally {
      setLoadingHistory(false);
    }
  };

  const handleKeywordChange = (index, value) => {
    const newKeywords = [...keywords];
    newKeywords[index] = value;
    setKeywords(newKeywords);
  };

  const addKeywordField = () => {
    setKeywords([...keywords, '']);
  };

  const generateReport = async () => {
    setLoading(true);
    setReport('');
    try {
      const { data, errors } = await client.mutations.generateReport({
        keywords: keywords.filter(k => k.trim() !== '')
      });

      if (errors) {
        console.error('GraphQL errors:', errors);
        setReport("Error generating report: " + errors[0].message);
      } else {
        // Clean up: if data is a technical string representation of a result object, parse it
        let cleanReport = data;
        if (typeof data === 'string') {
          // Handle the weird python dictionary string format: {statusCode=200, headers={...}, body={"report": "..."}}
          if (data.includes('body={"report":') || data.includes("body={'report':")) {
            try {
              // Extract everything from {"report": ...} to the end (excluding the closing brace of the main object if possible)
              const bodyMatch = data.match(/body=(\{"report":\s*[\s\S]*?\})\s*\}$/);
              if (bodyMatch && bodyMatch[1]) {
                const parsedBody = JSON.parse(bodyMatch[1]);
                cleanReport = parsedBody.report || parsedBody.body || data;
              } else {
                 // Fallback regex if it's deeply nested
                 const directMatch = data.match(/"report":\s*"(.*)"\s*\}/s);
                 if (directMatch && directMatch[1]) {
                   // Replace escaped newlines
                   cleanReport = directMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
                 }
              }
            } catch (e) {
              console.warn('Failed to parse complex report data string format, using fallback.');
            }
          }
        }
        setReport(cleanReport || "No report generated.");
      }
    } catch (error) {
      console.error('Error calling generateReport:', error);
      setReport("Error: " + (error.message || "Unknown error"));
    } finally {
      setLoading(false);
    }
  };

  const saveToStorage = async () => {
    if (!report) return;
    setSaving(true);
    try {
      await client.models.Diagnosis.create({
        details: details,
        keywords: keywords.filter(k => k.trim() !== ''),
        report: report
      });
      alert('✅ Diagnosis successfully saved to your history!');
      fetchHistory(); // Refresh history if panel is open
    } catch (error) {
      console.error('Error saving diagnosis:', error);
      alert('❌ Failed to save diagnosis: ' + (error.message || 'Unknown error'));
    } finally {
      setSaving(false);
    }
  };

  const deleteFromHistory = async (e, item) => {
    e.stopPropagation();
    if (!item || !item.id) return;
    
    try {
      console.log('Deleting diagnosis ID:', item.id);
      await client.models.Diagnosis.delete({ id: item.id });
      fetchHistory(); 
    } catch (error) {
      console.error('Error deleting diagnosis:', error);
    }
  };

  const downloadPDF = async () => {
    try {
      const date = new Date().toLocaleDateString();
      const doctorDisplayName = userProfile.firstName && userProfile.lastName 
        ? `${t('doctor_prefix')} ${userProfile.firstName} ${userProfile.lastName}`
        : user?.signInDetails?.loginId || 'N/A';
      
      // Create a hidden but "visible to layout" container
      const tempDiv = document.createElement('div');
      tempDiv.id = 'pdf-render-container';
      tempDiv.style.position = 'fixed';
      tempDiv.style.top = '0';
      tempDiv.style.left = '-2000px'; // Far off-screen
      tempDiv.style.width = '700px'; 
      tempDiv.style.padding = '40px';
      tempDiv.style.backgroundColor = '#ffffff';
      tempDiv.style.fontFamily = "'Inter', sans-serif";
      tempDiv.style.color = '#0f172a';
      tempDiv.style.lineHeight = '1.6';
      
      let htmlContent = `
        <div style="border-bottom: 2px solid #2563eb; padding-bottom: 20px; margin-bottom: 30px;">
          <h1 style="color: #2563eb; margin: 0; font-size: 28px;">dAIgnostics Studio VetNarrative</h1>
          <p style="color: #64748b; font-size: 14px; margin: 10px 0 0 0;">
            ${t('app_subtitle')}
          </p>
        </div>
        
        <div style="margin-bottom: 30px; display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
          <div>
            <p style="margin: 0; font-weight: 700; font-size: 12px; color: #64748b; text-transform: uppercase;">${lang === 'en' ? 'Generated On' : 'Generirano dana'}</p>
            <p style="margin: 5px 0 0 0; font-size: 16px;">${date}</p>
          </div>
          <div>
            <p style="margin: 0; font-weight: 700; font-size: 12px; color: #64748b; text-transform: uppercase;">${lang === 'en' ? 'Doctor' : 'Doktor'}</p>
            <p style="margin: 5px 0 0 0; font-size: 16px;">${doctorDisplayName}</p>
          </div>
        </div>
      `;
      
      if (details) {
        htmlContent += `
          <div style="margin-bottom: 25px;">
            <p style="margin: 0 0 10px 0; font-weight: 700; font-size: 14px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px;">${t('case_details')}:</p>
            <p style="margin: 0; font-size: 14px; white-space: pre-wrap; color: #475569;">${details}</p>
          </div>
        `;
      }
      
      const activeKeywords = keywords.filter(k => k.trim() !== '').join(', ');
      if (activeKeywords) {
        htmlContent += `
          <div style="margin-bottom: 25px;">
            <p style="margin: 0 0 10px 0; font-weight: 700; font-size: 14px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px;">${t('observations_label')}:</p>
            <p style="margin: 0; font-size: 14px; color: #475569;">${activeKeywords}</p>
          </div>
        `;
      }
      
      htmlContent += `
        <div style="margin-bottom: 25px;">
          <p style="margin: 0 0 10px 0; font-weight: 700; font-size: 14px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px;">${t('narrative_report')}:</p>
          <div style="margin: 0; font-size: 14px; line-height: 1.8; color: #1e293b; white-space: pre-wrap;">${report}</div>
        </div>
        
        <div style="margin-top: 50px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; color: #94a3b8; font-size: 10px;">
          ${t('footer_text')}
        </div>
      `;
      
      tempDiv.innerHTML = htmlContent;
      document.body.appendChild(tempDiv);
      
      // Wait for font/rendering
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const canvas = await html2canvas(tempDiv, {
        scale: 2, // Retina quality
        useCORS: true,
        backgroundColor: '#ffffff'
      });
      
      const imgData = canvas.toDataURL('image/jpeg', 0.95);
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'px',
        format: [canvas.width / 2, canvas.height / 2] // Scale to actual dimensions
      });
      
      pdf.addImage(imgData, 'JPEG', 0, 0, canvas.width / 2, canvas.height / 2);
      
      const fileName = `veterinary_report_${new Date().getTime()}.pdf`;
      
      const pdfBlob = pdf.output('blob');
      const blobUrl = URL.createObjectURL(pdfBlob);
      
      // Open in a new tab to bypass the /tmp/ download interceptor issues.
      // The user can then see the report and use the browser's "Save" or "Download" icon.
      const newTab = window.open(blobUrl, '_blank');
      
      // Cleanup the DOM element
      document.body.removeChild(tempDiv);
      
      // If the tab opened successfully, we can't reliably set the title for a Blob URL in all browsers,
      // but the data is there for viewing. 
      if (!newTab) {
        // Fallback to download if popup is blocked
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
      
      // Revoke after a delay to ensure the new tab has loaded it
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    } catch (error) {
      console.error('Error in PDF generation flow:', error);
      alert('❌ Failed to generate PDF: ' + (error.message || 'Unknown error'));
    }
  };

  const resetForm = () => {
    setDetails('');
    setKeywords(['', '', '']);
    setReport('');
    setShowHistory(false);
    setShowProfile(false);
  };

  const loadFromHistory = (item) => {
    setDetails(item.details || '');
    setKeywords(item.keywords || []);
    setReport(item.report);
    setShowHistory(false);
  };

  const ProfileModal = () => {
    const [editingProfile, setEditingProfile] = useState({ ...userProfile });
    const [passwords, setPasswords] = useState({ old: '', new: '', confirm: '' });
    const [savingProfile, setSavingProfile] = useState(false);
    const [changingPassword, setChangingPassword] = useState(false);

    const handleUpdateProfile = async (e) => {
      e.preventDefault();
      setSavingProfile(true);
      try {
        await updateUserAttributes({
          userAttributes: {
            given_name: editingProfile.firstName,
            family_name: editingProfile.lastName
          }
        });
        await loadProfile();
        alert(t('profile_update_success'));
      } catch (err) {
        console.error(err);
        alert('Error: ' + err.message);
      } finally {
        setSavingProfile(false);
      }
    };

    const handleChangePassword = async (e) => {
      e.preventDefault();
      if (passwords.new !== passwords.confirm) {
        alert(t('password_match_error'));
        return;
      }
      setChangingPassword(true);
      try {
        await updatePassword({
          oldPassword: passwords.old,
          newPassword: passwords.new
        });
        alert(t('password_change_success'));
        setPasswords({ old: '', new: '', confirm: '' });
      } catch (err) {
        console.error(err);
        alert('Error: ' + err.message);
      } finally {
        setChangingPassword(false);
      }
    };

    return (
      <div className="profile-overlay" onClick={() => setShowProfile(false)}>
        <div className="profile-panel" onClick={e => e.stopPropagation()}>
          <div className="profile-header">
            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <User size={20} /> {t('profile_title')}
            </h3>
            <button className="btn btn-ghost" onClick={() => setShowProfile(false)}>
              <X size={20} />
            </button>
          </div>
          <div className="profile-body">
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>{t('profile_instructions')}</p>
            
            <form className="profile-section" onSubmit={handleUpdateProfile}>
              <h4><ShieldCheck size={18} /> {t('profile_title')}</h4>
              <div className="profile-row">
                <div>
                  <label className="input-label">{t('first_name')}</label>
                  <input 
                    type="text" 
                    value={editingProfile.firstName} 
                    onChange={e => setEditingProfile({...editingProfile, firstName: e.target.value})}
                    required
                  />
                </div>
                <div>
                  <label className="input-label">{t('last_name')}</label>
                  <input 
                    type="text" 
                    value={editingProfile.lastName} 
                    onChange={e => setEditingProfile({...editingProfile, lastName: e.target.value})}
                    required
                  />
                </div>
              </div>
              <button className="btn btn-primary" style={{ width: '100%' }} disabled={savingProfile}>
                {savingProfile ? <div className="loading-spinner"></div> : t('update_profile')}
              </button>
            </form>

            <hr style={{ margin: '2rem 0', border: 'none', borderTop: '1px solid var(--border)' }} />

            <form className="profile-section" onSubmit={handleChangePassword}>
              <h4><Lock size={18} /> {t('change_password')}</h4>
              <div style={{ marginBottom: '1rem' }}>
                <label className="input-label">{t('old_password')}</label>
                <input 
                  type="password" 
                  value={passwords.old} 
                  onChange={e => setPasswords({...passwords, old: e.target.value})}
                  required
                />
              </div>
              <div className="profile-row">
                <div>
                  <label className="input-label">{t('new_password')}</label>
                  <input 
                    type="password" 
                    value={passwords.new} 
                    onChange={e => setPasswords({...passwords, new: e.target.value})}
                    required
                  />
                </div>
                <div>
                  <label className="input-label">{t('confirm_password')}</label>
                  <input 
                    type="password" 
                    value={passwords.confirm} 
                    onChange={e => setPasswords({...passwords, confirm: e.target.value})}
                    required
                  />
                </div>
              </div>
              <button className="btn btn-secondary" style={{ width: '100%' }} disabled={changingPassword}>
                {changingPassword ? <div className="loading-spinner"></div> : t('change_password')}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="app-container">
      <header>
        <div 
          style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}
          onClick={resetForm}
          title={lang === 'en' ? 'New Diagnosis' : 'Novi nalaz'}
        >
          <Stethoscope size={32} color="var(--brand-red)" />
          <h1 className="hide-mobile" style={{ fontSize: '1.25rem' }}>dAIgnostics Studio VetNarrative</h1>
        </div>
        
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          <div className="tab-toggle">
            <button
              className={`tab-btn ${activeTab === 'generator' ? 'active' : ''}`}
              onClick={() => setActiveTab('generator')}
            >
              <Stethoscope size={16} /> {t('tab_generator')}
            </button>
            <button
              className={`tab-btn ${activeTab === 'referral' ? 'active' : ''}`}
              onClick={() => setActiveTab('referral')}
            >
              <ScanLine size={16} /> {t('tab_referral')}
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div className="user-pill" onClick={() => setShowProfile(true)}>
            <User size={18} />
            <span className="hide-mobile" style={{ maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {userProfile.firstName && userProfile.lastName 
                ? `${userProfile.firstName} ${userProfile.lastName}` 
                : user?.signInDetails?.loginId}
            </span>
          </div>

          <button onClick={() => setShowHistory(true)} className="btn btn-ghost" title={t('history')}>
            <History size={20} />
          </button>
          
          <div className="lang-toggle" style={{ margin: 0 }}>
            <button className={`lang-btn ${lang === 'en' ? 'active' : ''}`} onClick={() => setLang('en')}>EN</button>
            <button className={`lang-btn ${lang === 'hr' ? 'active' : ''}`} onClick={() => setLang('hr')}>HR</button>
          </div>

          <button onClick={signOut} className="btn btn-ghost" title={t('sign_out')}>
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <main className="main-content" hidden={activeTab !== 'referral'}>
        <ReferralOcr lang={lang} />
      </main>

      <main
        className={`main-content ${report ? 'with-report' : ''}`}
        hidden={activeTab !== 'generator'}
      >
        <section className="card keyword-section">
          <h2>{t('clinical_input')}</h2>
          <p style={{ marginBottom: '1.5rem', color: 'var(--text-muted)' }}>
            {t('clinical_input_subtitle')}
          </p>

          <div style={{ marginBottom: '1.5rem' }}>
            <label className="input-label">{t('case_details')}</label>
            <textarea
              className="details-textarea"
              placeholder={t('case_details_placeholder')}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
            />
          </div>
          
          <div>
            <label className="input-label">{t('observations_label')}</label>
            <div className="keyword-inputs">
              {keywords.map((kw, index) => (
                <input
                  key={index}
                  type="text"
                  placeholder={`${t('observation_placeholder')} ${index + 1}...`}
                  value={kw}
                  onChange={(e) => handleKeywordChange(index, e.target.value)}
                />
              ))}
            </div>
            <div style={{ marginTop: '0.75rem' }}>
              <button className="btn btn-secondary btn-sm" onClick={addKeywordField} title={t('add_observation')}>
                <Plus size={16} /> {t('add_observation')}
              </button>
            </div>
          </div>

          <button 
            className="btn btn-primary" 
            style={{ width: '100%', marginTop: '2rem' }}
            onClick={generateReport}
            disabled={loading || (keywords.every(k => k.trim() === '') && !details)}
          >
            {loading ? <div className="loading-spinner"></div> : <><Send size={18} /> {t('generate_btn')}</>}
          </button>
        </section>

        {report && (
          <section className="card report-output">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FileText size={20} /> {t('narrative_report')}
              </h3>
              <div className="actions">
                <button className="btn btn-secondary" onClick={downloadPDF} title={t('pdf_btn')}>
                  <Download size={18} /> {t('pdf_btn')}
                </button>
                <button 
                  className="btn btn-primary" 
                  onClick={saveToStorage} 
                  disabled={saving}
                  title={t('save_btn')}
                >
                  {saving ? <div className="loading-spinner"></div> : <><Save size={18} /> {t('save_btn')}</>}
                </button>
              </div>
            </div>
            <textarea 
              className="report-text" 
              value={report} 
              onChange={(e) => setReport(e.target.value)}
              style={{ width: '100%', minHeight: '400px', border: 'none', resize: 'vertical', display: 'block' }}
            />
          </section>
        )}
      </main>

      {showHistory && (
        <div className="history-overlay" onClick={() => setShowHistory(false)}>
          <div className="history-panel" onClick={e => e.stopPropagation()}>
            <div className="history-header">
              <h3 style={{ margin: 0 }}>{t('diagnosis_history')}</h3>
              <button className="btn btn-ghost" onClick={() => setShowHistory(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="history-list">
              {loadingHistory ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
                  <div className="loading-spinner"></div>
                </div>
              ) : history.length === 0 ? (
                <p style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{t('no_history')}</p>
              ) : (
                history.map(item => (
                  <div key={item.id} className="history-item" onClick={() => loadFromHistory(item)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <h4 style={{ color: 'var(--primary)', flex: 1, margin: 0, paddingRight: '1rem' }}>
                        {item.details?.slice(0, 30) || item.keywords?.slice(0, 3).join(', ') || 'Diagnostic Report'}
                      </h4>
                      <button 
                        type="button"
                        className="btn btn-ghost" 
                        style={{ padding: '0.6rem', color: '#ef4444', zIndex: 10, position: 'relative' }} 
                        onClick={(e) => deleteFromHistory(e, item)}
                        title="Delete Diagnosis"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    {item.details && <p style={{ fontSize: '0.8rem', fontStyle: 'italic', marginBottom: '0.5rem', marginTop: '0.5rem' }}>{item.details.slice(0, 60)}...</p>}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      <Clock size={12} /> {new Date(item.createdAt).toLocaleDateString()} at {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {showProfile && <ProfileModal />}

      <footer className="footer">
        {t('footer_text')}
      </footer>
    </div>
  );
}

export default function App() {
  const formFields = {
    signUp: {
      email: { order: 1 },
      given_name: { 
        label: 'First Name', 
        placeholder: 'Enter your first name', 
        required: true,
        order: 2 
      },
      family_name: { 
        label: 'Last Name', 
        placeholder: 'Enter your last name', 
        required: true,
        order: 3 
      },
      password: { order: 4 },
      confirm_password: { order: 5 }
    }
  };

  const components = {
    Header() {
      return (
        <div style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--brand-red)' }}>
          <Stethoscope size={56} style={{ marginBottom: '0.75rem' }} />
          <h2 style={{ margin: 0, fontWeight: 800, letterSpacing: '-0.025em', color: 'var(--primary)' }}>dAIgnostics Studio VetNarrative</h2>
        </div>
      );
    },
    Footer() {
      return (
        <div style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--brand-red)', fontSize: '0.75rem' }}>
          &copy; 2026 dAIgnostics Studio VetNarrative | Daignostics d.o.o
        </div>
      );
    },
  };

  return (
    <div className="auth-wrapper">
      <Authenticator components={components} formFields={formFields}>
        {({ signOut, user }) => (
          <GeneratorContent signOut={signOut} user={user} />
        )}
      </Authenticator>
    </div>
  );
}
