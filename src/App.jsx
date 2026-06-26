import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  Search,
  Mic,
  MicOff
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { fetchUserAttributes, updateUserAttributes, updatePassword, fetchAuthSession } from 'aws-amplify/auth';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import '@aws-amplify/ui-react/styles.css';
import outputs from '../amplify_outputs.json';
import { translations } from './translations';
import './index.css';

Amplify.configure(outputs);
const client = generateClient();

// ─── Bedrock TEXT helper (runs client-side with Cognito credentials) ───
const BEDROCK_REGION = 'us-east-1';
const BEDROCK_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

async function processTextWithBedrock(rawText, mode, lang) {
  try {
    const session = await fetchAuthSession();
    const credentials = session.credentials;
    if (!credentials) throw new Error('No credentials');

    const bedrockClient = new BedrockRuntimeClient({
      region: BEDROCK_REGION,
      credentials,
    });

    let systemPrompt, userMessage;
    if (mode === 'details') {
      systemPrompt = 'You are a veterinary medical transcription assistant. You receive raw speech-to-text transcriptions from veterinarians dictating case descriptions. Clean up the text into a professional, concise veterinary case description. Fix grammar, remove filler words (um, uh, like, so), and format properly. Preserve ALL clinical information. Return ONLY the cleaned text, nothing else.';
      userMessage = `Clean up this dictated veterinary case description. The text is in ${lang === 'hr' ? 'Croatian' : 'English'}. Return ONLY the cleaned professional text:\n\n${rawText}`;
    } else {
      systemPrompt = 'You are a veterinary keyword extraction assistant. You receive raw speech-to-text transcriptions from veterinarians dictating clinical observations. Extract individual clinical keywords or observations. Return ONLY a JSON array of strings, each being one keyword/observation. Examples: ["limping", "elevated temperature", "loss of appetite"]. Remove filler words and duplicates. Return ONLY the JSON array, no other text.';
      userMessage = `Extract clinical keywords from this dictated text. The text is in ${lang === 'hr' ? 'Croatian' : 'English'}. Return ONLY a JSON array of keyword strings:\n\n${rawText}`;
    }

    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: userMessage,
      }],
    });

    const command = new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(body),
    });

    const response = await bedrockClient.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const resultText = responseBody.content?.[0]?.text || '';

    if (mode === 'keywords') {
      const match = resultText.match(/\[[\s\S]*?\]/);
      if (match) {
        return { type: 'keywords', data: JSON.parse(match[0]) };
      }
      return { type: 'keywords', data: resultText.split(',').map(k => k.trim().replace(/^["']|["']$/g, '')).filter(Boolean) };
    }

    return { type: 'text', data: resultText.trim() };
  } catch (err) {
    console.error('Bedrock text processing error:', err);
    return null;
  }
}

// ─── Cross-browser voice input hook using SpeechRecognition ───
const SpeechRecognition = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

function useVoiceInput() {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const recognitionRef = useRef(null);
  const transcriptRef = useRef('');
  const onResultRef = useRef(null);

  const startRecording = useCallback(async (onResult, langCode) => {
    if (!SpeechRecognition) {
      return false;
    }
    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = langCode === 'hr' ? 'hr-HR' : 'en-US';
      transcriptRef.current = '';
      onResultRef.current = onResult;

      recognition.onresult = (event) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            transcript += event.results[i][0].transcript + ' ';
          }
        }
        transcriptRef.current += transcript;
      };

      recognition.onerror = (event) => {
        console.error('SpeechRecognition error:', event.error);
        // Don't treat 'no-speech' as a fatal error — user just didn't say anything yet
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          setIsRecording(false);
        }
      };

      recognition.onend = () => {
        setIsRecording(false);
        const finalText = transcriptRef.current.trim();
        if (finalText && onResultRef.current) {
          onResultRef.current(finalText);
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
      setIsRecording(true);
      return true;
    } catch (err) {
      console.error('SpeechRecognition start error:', err);
      setIsRecording(false);
      return false;
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
  }, []);

  return { isRecording, isProcessing, setIsProcessing, startRecording, stopRecording };
}

function GeneratorContent({ signOut, user }) {
  const [lang, setLang] = useState(localStorage.getItem('vet_lang') || 'en');
  const [details, setDetails] = useState('');
  const [keywords, setKeywords] = useState(['', '', '']);
  const [report, setReport] = useState('');
  const [results, setResults] = useState([]);
  const [resultSource, setResultSource] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [editedOpis, setEditedOpis] = useState('');
  const [editedDg, setEditedDg] = useState('');
  const [loading, setLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [noDbResults, setNoDbResults] = useState(false);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [userProfile, setUserProfile] = useState({ firstName: '', lastName: '' });

  // Voice input hooks — one for details, one for keywords
  const detailsVoice = useVoiceInput();
  const keywordsVoice = useVoiceInput();

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

  // ─── Voice handlers ───
  const handleDetailsVoice = async () => {
    if (detailsVoice.isRecording) {
      detailsVoice.stopRecording();
    } else {
      const started = await detailsVoice.startRecording(async (rawText) => {
        // rawText is the speech-to-text transcript from SpeechRecognition
        detailsVoice.setIsProcessing(true);
        try {
          const result = await processTextWithBedrock(rawText, 'details', lang);
          if (result && result.data) {
            setDetails(prev => prev ? prev + '\n' + result.data : result.data);
          } else {
            // Bedrock cleanup failed — fall back to raw transcription
            setDetails(prev => prev ? prev + '\n' + rawText : rawText);
          }
        } catch (err) {
          console.error('Voice details processing error:', err);
          // Still use the raw transcript so the user isn't left empty-handed
          setDetails(prev => prev ? prev + '\n' + rawText : rawText);
        } finally {
          detailsVoice.setIsProcessing(false);
        }
      }, lang);
      if (!started) {
        alert(t('voice_not_supported'));
      }
    }
  };

  const handleKeywordsVoice = async () => {
    if (keywordsVoice.isRecording) {
      keywordsVoice.stopRecording();
    } else {
      const started = await keywordsVoice.startRecording(async (rawText) => {
        // rawText is the speech-to-text transcript from SpeechRecognition
        keywordsVoice.setIsProcessing(true);
        try {
          const result = await processTextWithBedrock(rawText, 'keywords', lang);
          if (result && result.type === 'keywords' && Array.isArray(result.data)) {
            setKeywords(prev => {
              const newKeywords = [...prev];
              let insertIdx = 0;
              for (const kw of result.data) {
                while (insertIdx < newKeywords.length && newKeywords[insertIdx].trim() !== '') {
                  insertIdx++;
                }
                if (insertIdx < newKeywords.length) {
                  newKeywords[insertIdx] = kw;
                } else {
                  newKeywords.push(kw);
                }
                insertIdx++;
              }
              return newKeywords;
            });
          } else {
            // Bedrock extraction failed — put the raw text in the first empty keyword slot
            setKeywords(prev => {
              const newKeywords = [...prev];
              const emptyIdx = newKeywords.findIndex(k => k.trim() === '');
              if (emptyIdx >= 0) {
                newKeywords[emptyIdx] = rawText;
              } else {
                newKeywords.push(rawText);
              }
              return newKeywords;
            });
          }
        } catch (err) {
          console.error('Voice keywords processing error:', err);
          setKeywords(prev => {
            const newKeywords = [...prev];
            const emptyIdx = newKeywords.findIndex(k => k.trim() === '');
            if (emptyIdx >= 0) {
              newKeywords[emptyIdx] = rawText;
            } else {
              newKeywords.push(rawText);
            }
            return newKeywords;
          });
        } finally {
          keywordsVoice.setIsProcessing(false);
        }
      }, lang);
      if (!started) {
        alert(t('voice_not_supported'));
      }
    }
  };

  const generateReport = async () => {
    setLoading(true);
    setReport('');
    setNoDbResults(false);
    try {
      const { data, errors } = await client.mutations.generateReport({
        keywords: keywords.filter(k => k.trim() !== '')
      });

      if (errors) {
        console.error('GraphQL errors:', errors);
        setReport("Error generating report: " + errors[0].message);
        setResults([]);
      } else {
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          if (parsed.results && Array.isArray(parsed.results)) {
            setResults(parsed.results);
            setResultSource(parsed.source || '');
            setReport('');
            if (parsed.results.length === 1) {
              setSelectedIdx(0);
              setEditedOpis(parsed.results[0].opis || '');
              setEditedDg(parsed.results[0].dg || '');
            } else {
              setSelectedIdx(null);
              setEditedOpis('');
              setEditedDg('');
            }
          } else if (parsed.opis || parsed.dg) {
            setResults([{ opis: parsed.opis, dg: parsed.dg }]);
            setResultSource(parsed.source || '');
            setSelectedIdx(0);
            setEditedOpis(parsed.opis || '');
            setEditedDg(parsed.dg || '');
            setReport('');
          } else {
            setReport(data || "No report generated.");
            setResults([]);
            setSelectedIdx(null);
          }
        } catch (e) {
          setReport(data || "No report generated.");
          setResults([]);
          setSelectedIdx(null);
        }
      }
    } catch (error) {
      console.error('Error calling generateReport:', error);
      setReport("Error: " + (error.message || "Unknown error"));
    } finally {
      setLoading(false);
    }
  };

  const searchDatabase = async () => {
    setSearchLoading(true);
    setReport('');
    setResults([]);
    setResultSource('');
    setNoDbResults(false);
    setSelectedIdx(null);
    setEditedOpis('');
    setEditedDg('');
    try {
      const { data, errors } = await client.graphql({
        query: `mutation SearchDatabase($keywords: [String], $action: String) { searchDatabase(keywords: $keywords, action: $action) }`,
        variables: { keywords: keywords.filter(k => k.trim() !== ''), action: 'search' }
      });
      if (errors) {
        console.error('GraphQL errors:', errors);
        setReport("Error: " + errors[0].message);
      } else {
        const raw = data?.searchDatabase ?? data;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (parsed.source === 'none' || !parsed.results || parsed.results.length === 0) {
          setNoDbResults(true);
        } else {
          setResults(parsed.results);
          setResultSource(parsed.source || 'router');
          if (parsed.results.length === 1) {
            setSelectedIdx(0);
            setEditedOpis(parsed.results[0].opis || '');
            setEditedDg(parsed.results[0].dg || '');
          }
        }
      }
    } catch (error) {
      console.error('Error calling searchDatabase:', error);
      setReport("Error: " + (error.message || "Unknown error"));
    } finally {
      setSearchLoading(false);
    }
  };

  const selectResult = (idx) => {
    setSelectedIdx(idx);
    setEditedOpis(results[idx].opis || '');
    setEditedDg(results[idx].dg || '');
  };

  const activeReport = selectedIdx !== null
    ? `OPIS:\n${editedOpis}\n\nDIJAGNOZA:\n${editedDg}`
    : report;

  const saveToStorage = async () => {
    if (!activeReport) {
      alert('Odaberi nalaz za spremanje.');
      return;
    }
    setSaving(true);
    try {
      await client.models.Diagnosis.create({
        details: details,
        keywords: keywords.filter(k => k.trim() !== ''),
        report: activeReport
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
    if (!activeReport) {
      alert('Odaberi nalaz za PDF.');
      return;
    }
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
          <h1 style="color: #2563eb; margin: 0; font-size: 28px;">dAIgnostics Studio</h1>
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
      
      if (selectedIdx !== null) {
        htmlContent += `
          <div style="margin-bottom: 25px;">
            <p style="margin: 0 0 10px 0; font-weight: 700; font-size: 14px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px;">Opis:</p>
            <div style="margin: 0; font-size: 14px; line-height: 1.8; color: #1e293b; white-space: pre-wrap;">${editedOpis}</div>
          </div>
          <div style="margin-bottom: 25px;">
            <p style="margin: 0 0 10px 0; font-weight: 700; font-size: 14px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px;">Dijagnoza:</p>
            <div style="margin: 0; font-size: 14px; font-weight: 600; color: #1e293b;">${editedDg}</div>
          </div>`;
      } else {
        htmlContent += `
          <div style="margin-bottom: 25px;">
            <p style="margin: 0 0 10px 0; font-weight: 700; font-size: 14px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px;">${t('narrative_report')}:</p>
            <div style="margin: 0; font-size: 14px; line-height: 1.8; color: #1e293b; white-space: pre-wrap;">${report}</div>
          </div>`;
      }
      htmlContent += `
        
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
    setResults([]);
    setResultSource('');
    setSelectedIdx(null);
    setEditedOpis('');
    setEditedDg('');
    setNoDbResults(false);
    setShowHistory(false);
    setShowProfile(false);
  };

  const loadFromHistory = (item) => {
    setDetails(item.details || '');
    setKeywords(item.keywords || []);
    setResults([]);
    setResultSource('');
    setSelectedIdx(null);
    setEditedOpis('');
    setEditedDg('');
    setReport(item.report || '');
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
          <h1 className="hide-mobile" style={{ fontSize: '1.25rem' }}>dAIgnostics Studio</h1>
        </div>
        
        <div style={{ flex: 1 }}></div>

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

      <main className={`main-content ${(results.length > 0 || report) ? 'with-report' : ''}`}>
        <section className="card keyword-section">
          <h2>{t('clinical_input')}</h2>
          <p style={{ marginBottom: '1.5rem', color: 'var(--text-muted)' }}>
            {t('clinical_input_subtitle')}
          </p>

          <div style={{ marginBottom: '1.5rem' }}>
            <div className="label-with-mic">
              <label className="input-label" style={{ marginBottom: 0 }}>{t('case_details')}</label>
              <button
                type="button"
                className={`mic-btn ${detailsVoice.isRecording ? 'recording' : ''} ${detailsVoice.isProcessing ? 'processing' : ''}`}
                onClick={handleDetailsVoice}
                title={detailsVoice.isRecording ? t('voice_input_stop') : t('voice_input_start')}
                disabled={detailsVoice.isProcessing}
              >
                {detailsVoice.isProcessing ? (
                  <div className="mic-spinner" />
                ) : detailsVoice.isRecording ? (
                  <MicOff size={15} />
                ) : (
                  <Mic size={15} />
                )}
              </button>
              {detailsVoice.isProcessing && (
                <span style={{ fontSize: '0.8rem', color: 'var(--primary)', fontWeight: 500 }}>{t('voice_processing')}</span>
              )}
            </div>
            <textarea
              className="details-textarea"
              placeholder={t('case_details_placeholder')}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              style={{ marginTop: '0.5rem' }}
            />
          </div>
          
          <div>
            <div className="label-with-mic">
              <label className="input-label" style={{ marginBottom: 0 }}>{t('observations_label')}</label>
              <button
                type="button"
                className={`mic-btn ${keywordsVoice.isRecording ? 'recording' : ''} ${keywordsVoice.isProcessing ? 'processing' : ''}`}
                onClick={handleKeywordsVoice}
                title={keywordsVoice.isRecording ? t('voice_input_stop') : t('voice_input_start')}
                disabled={keywordsVoice.isProcessing}
              >
                {keywordsVoice.isProcessing ? (
                  <div className="mic-spinner" />
                ) : keywordsVoice.isRecording ? (
                  <MicOff size={15} />
                ) : (
                  <Mic size={15} />
                )}
              </button>
              {keywordsVoice.isProcessing && (
                <span style={{ fontSize: '0.8rem', color: 'var(--primary)', fontWeight: 500 }}>{t('voice_processing')}</span>
              )}
            </div>
            <div className="keyword-inputs" style={{ marginTop: '0.5rem' }}>
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
            disabled={loading || searchLoading || (keywords.every(k => k.trim() === '') && !details)}
          >
            {loading ? <div className="loading-spinner"></div> : <><Send size={18} /> {t('generate_btn')}</>}
          </button>
          <button
            className="btn btn-secondary"
            style={{ width: '100%', marginTop: '0.75rem' }}
            onClick={searchDatabase}
            disabled={searchLoading || loading || (keywords.every(k => k.trim() === '') && !details)}
          >
            {searchLoading ? <div className="loading-spinner"></div> : <><Search size={18} /> {t('search_btn')}</>}
          </button>
        </section>

        {results.length > 0 && (
          <section className="card report-output">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FileText size={20} />
                {resultSource === 'router' ? `📚 ${results.length} rezultat${results.length > 1 ? 'a' : ''} iz baze` : '🤖 Generirano'}
              </h3>
              <div className="actions">
                <button className="btn btn-secondary" onClick={downloadPDF} disabled={selectedIdx === null} title={t('pdf_btn')}>
                  <Download size={18} /> {t('pdf_btn')}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={saveToStorage}
                  disabled={saving || selectedIdx === null}
                  title={t('save_btn')}
                >
                  {saving ? <div className="loading-spinner"></div> : <><Save size={18} /> {t('save_btn')}</>}
                </button>
              </div>
            </div>
            {results.length > 1 && selectedIdx === null && (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                Odaberi jedan nalaz za uređivanje, spremanje ili PDF izvoz.
              </p>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              {results.map((r, i) => {
                const isSelected = selectedIdx === i;
                return (
                  <div key={i} style={{
                    border: `2px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
                    borderRadius: '8px',
                    padding: '1.25rem',
                    opacity: selectedIdx !== null && !isSelected ? 0.5 : 1,
                    transition: 'all 0.15s',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                      {results.length > 1 && (
                        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: isSelected ? 'var(--primary)' : 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          Nalaz {i + 1}
                        </div>
                      )}
                      <div style={{ marginLeft: 'auto' }}>
                        {isSelected ? (
                          <button className="btn btn-secondary btn-sm" onClick={() => { setSelectedIdx(null); setEditedOpis(''); setEditedDg(''); }}>
                            Poništi odabir
                          </button>
                        ) : (
                          <button className="btn btn-primary btn-sm" onClick={() => selectResult(i)}>
                            Odaberi
                          </button>
                        )}
                      </div>
                    </div>

                    <div style={{ marginBottom: '1rem' }}>
                      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '0.4rem', textTransform: 'uppercase' }}>Opis</div>
                      {isSelected ? (
                        <textarea
                          value={editedOpis}
                          onChange={(e) => setEditedOpis(e.target.value)}
                          style={{ width: '100%', minHeight: '140px', resize: 'vertical', lineHeight: 1.7, padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--border)', fontFamily: 'inherit', fontSize: '0.95rem' }}
                        />
                      ) : (
                        <p style={{ margin: 0, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{r.opis}</p>
                      )}
                    </div>

                    <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '0.4rem', textTransform: 'uppercase' }}>Dijagnoza</div>
                      {isSelected ? (
                        <input
                          value={editedDg}
                          onChange={(e) => setEditedDg(e.target.value)}
                          style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--border)', fontFamily: 'inherit', fontSize: '0.95rem', fontWeight: 600 }}
                        />
                      ) : (
                        <p style={{ margin: 0, fontWeight: 600 }}>{r.dg}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {noDbResults && !results.length && (
          <section className="card report-output">
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem 0', fontSize: '1rem' }}>
              🔍 {t('no_db_results')}
            </p>
          </section>
        )}

        {report && !results.length && (
          <section className="card report-output">
            <h3 style={{ margin: '0 0 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <FileText size={20} /> {t('narrative_report')}
            </h3>
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
          <h2 style={{ margin: 0, fontWeight: 800, letterSpacing: '-0.025em', color: 'var(--primary)' }}>dAIgnostics Studio</h2>
        </div>
      );
    },
    Footer() {
      return (
        <div style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--brand-red)', fontSize: '0.75rem' }}>
          &copy; 2026 dAIgnostics Studio | Daignostics d.o.o
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
