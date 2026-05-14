# 🩺 dAIgnostics Studio — VetNarrative

> AI-powered veterinary narrative report generator, built on AWS Amplify Gen 2.

VetNarrative helps veterinary professionals instantly generate structured, professional narrative reports from clinical keywords and case notes. It eliminates the time spent on documentation by using Amazon Bedrock (Claude 3 Haiku) to produce publication-quality veterinary narratives in seconds.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Local Development](#local-development)
- [Backend (Amplify Gen 2)](#backend-amplify-gen-2)
  - [Authentication](#authentication)
  - [Data Layer (GraphQL)](#data-layer-graphql)
  - [AI Report Generation (Lambda)](#ai-report-generation-lambda)
- [Frontend](#frontend)
  - [UI & Internationalisation](#ui--internationalisation)
  - [Key Screens](#key-screens)
- [Deployment](#deployment)
  - [AWS Amplify CI/CD](#aws-amplify-cicd)
  - [Environment Notes](#environment-notes)
- [Known Constraints](#known-constraints)
- [License](#license)

---

## Overview

VetNarrative is a full-stack SaaS web application developed by **Daignostics d.o.o** under the **dAIgnostics Studio** product line. It is designed specifically for veterinary clinics and practitioners who need to produce detailed narrative reports quickly.

A veterinarian enters:
1. **Case details** — patient history, context, notes
2. **Clinical observations** — individual keywords (e.g. "limping", "elevated temperature", "loss of appetite")

The system calls an AWS Lambda function that passes these inputs to **Amazon Bedrock** (Claude 3 Haiku) along with curated veterinary report examples. The model returns a complete, professionally worded narrative report.

The report can then be:
- **Edited** in-browser
- **Saved** to the user's private history (owner-scoped via Cognito)
- **Exported as PDF**

---

## Features

| Feature | Description |
|---|---|
| 🤖 AI Report Generation | Generates professional veterinary narratives using Claude 3 Haiku via Amazon Bedrock |
| 🔐 Secure Authentication | Email + password login with Cognito User Pools; first and last name required at registration |
| 📋 Diagnosis History | Each user's reports are stored privately and accessible from a slide-in history panel |
| 🗑️ Delete History | Individual diagnosis records can be deleted from history |
| 📄 PDF Export | Reports are rendered and exported as downloadable, print-ready PDFs using jsPDF + html2canvas |
| ✏️ Editable Reports | Generated reports can be edited in-browser before saving or exporting |
| 👤 Profile Management | Users can update their name and change their password from within the app |
| 🌐 Bilingual UI | Full English and Croatian (Hrvatski) language support, persisted in localStorage |
| 📱 Responsive Design | Works on desktop and mobile |

---

## Tech Stack

### Frontend
| Layer | Technology |
|---|---|
| Framework | React 18 (Vite) |
| Language | JavaScript (JSX) |
| Styling | Vanilla CSS with CSS custom properties |
| UI Icons | Lucide React |
| Auth UI | `@aws-amplify/ui-react` Authenticator component |
| PDF Generation | jsPDF + html2canvas |
| AWS Client | `aws-amplify` v6, `@aws-sdk/client-bedrock-runtime` |

### Backend
| Layer | Technology |
|---|---|
| Platform | AWS Amplify Gen 2 |
| Authentication | Amazon Cognito User Pools |
| API | AWS AppSync (GraphQL) |
| Database | Amazon DynamoDB (via AppSync) |
| AI/LLM | Amazon Bedrock — `anthropic.claude-3-haiku` (cross-region inference profile) |
| Lambda Runtime | Python 3.12 |
| IaC | AWS CDK (via Amplify Gen 2 backend definitions) |

---

## Architecture

```
Browser (React + Vite)
│
├── AWS Amplify Authenticator
│     └── Amazon Cognito User Pool
│           └── Email login, First name, Last name (required)
│
├── AppSync GraphQL API
│     ├── Diagnosis model  (owner-scoped — DynamoDB)
│     │     ├── list()
│     │     ├── create()
│     │     └── delete()
│     └── generateReport mutation
│           └── → AWS Lambda (Python 3.12)
│                     ├── Reads examples.text (bundled)
│                     └── → Amazon Bedrock (Claude 3 Haiku)
│                               └── Returns narrative text
│
└── jsPDF + html2canvas
      └── Client-side PDF rendering & export
```

The default GraphQL authorization mode is **userPool** (Cognito). The `Diagnosis` model uses `allow.owner()` so each user can only access their own reports. The `generateReport` mutation uses `allow.authenticated()`.

---

## Project Structure

```
veterina/
├── amplify/                        # Amplify Gen 2 backend
│   ├── backend.ts                  # Root backend definition (auth + data + functions)
│   ├── auth/
│   │   └── resource.ts             # Cognito User Pool config (email, given_name, family_name)
│   ├── data/
│   │   └── resource.ts             # AppSync GraphQL schema (Diagnosis model, generateReport mutation)
│   └── functions/
│       └── generate-report/
│           ├── handler.py          # Python Lambda — Bedrock invocation logic
│           ├── resource.ts         # CDK Lambda definition (Python 3.12, 30s timeout)
│           └── examples.text       # Curated veterinary report examples (few-shot prompt context)
│
├── src/
│   ├── App.jsx                     # Main React application (all UI logic)
│   ├── translations.js             # EN / HR i18n strings
│   ├── index.css                   # Global styles and CSS custom properties
│   └── App.css                     # Component-level styles
│
├── public/
│   └── favicon.svg                 # Stethoscope favicon (brand red)
│
├── index.html                      # App shell — title: "VetNarrative"
├── vite.config.js                  # Vite build config
├── amplify_outputs.json            # Auto-generated Amplify resource config (do not edit)
└── package.json
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- AWS account with Amplify access
- AWS CLI configured (for local `ampx` commands)
- Amazon Bedrock access enabled in `us-east-1` for `anthropic.claude-3-haiku-20240307-v1:0`

### Local Development

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Start the Vite dev server** (connects to the deployed Amplify sandbox or production backend via `amplify_outputs.json`)

   ```bash
   npm run dev
   ```

3. **Run a personal cloud sandbox** (optional, for isolated backend development)

   ```bash
   npx ampx sandbox
   ```

   This will provision a personal copy of the backend and update `amplify_outputs.json` automatically.

---

## Backend (Amplify Gen 2)

### Authentication

Defined in `amplify/auth/resource.ts`:

```typescript
export const auth = defineAuth({
  loginWith: { email: true },
  userAttributes: {
    givenName:  { required: true, mutable: true },
    familyName: { required: true, mutable: true },
  },
});
```

- Login method: **email + password**
- Required registration fields: email, first name, last name, password
- Cognito User Pool attributes are **immutable after pool creation** — to change them, the pool must be deleted and recreated (see [Known Constraints](#known-constraints))

### Data Layer (GraphQL)

Defined in `amplify/data/resource.ts`. The AppSync schema has two models and one custom mutation:

```
Diagnosis
  ├── details    : String      (optional case context)
  ├── keywords   : [String]    (clinical observations)
  ├── report     : String      (generated narrative)
  └── Authorization: allow.owner()   → private to the authenticated user

generateReport (mutation)
  ├── Input:  keywords: [String]
  ├── Output: String (narrative report)
  └── Handler: generate-report Lambda
  └── Authorization: allow.authenticated()
```

Default authorization mode: `userPool`. API key is also provisioned (30-day TTL) for the `DummyModel` used in internal tooling.

### AI Report Generation (Lambda)

Located at `amplify/functions/generate-report/`.

**Runtime:** Python 3.12  
**Timeout:** 30 seconds  
**Bedrock model:** `us.anthropic.claude-3-haiku-20240307-v1:0` (cross-region inference profile, `us-east-1`)

**Flow:**

1. AppSync invokes the Lambda with `{ arguments: { keywords: [...] } }`
2. Lambda reads the bundled `examples.text` file (curated veterinary report examples used as few-shot context)
3. Constructs a prompt: _"Given these keywords and examples, generate a professional veterinary narrative report"_
4. Calls `bedrock.invoke_model()` with the Claude messages API
5. Returns the generated text directly to AppSync, which returns it to the frontend

**IAM Permissions:** The Lambda role is granted `bedrock:InvokeModel` on `arn:aws:bedrock:*::foundation-model/*` and `arn:aws:bedrock:*:*:inference-profile/*` via an inline policy in `backend.ts`.

---

## Frontend

### UI & Internationalisation

The entire UI is in `src/App.jsx` (~664 lines). Styles use CSS custom properties defined in `src/index.css`.

Language is toggled between **English (EN)** and **Croatian (HR)** via a button in the header. The selection is persisted in `localStorage` under the key `vet_lang`. All user-facing strings are looked up from `src/translations.js`.

### Key Screens

**Login / Register**
- `@aws-amplify/ui-react` `<Authenticator>` component
- Custom header shows the stethoscope logo and app name
- Registration form collects: email, first name, last name, password, confirm password

**Main Generator**
- **Case Details** — free-text textarea for patient history and context
- **Clinical Observations** — dynamic list of keyword inputs (starts with 3, user can add more)
- **Generate Narrative** button — triggers the `generateReport` GraphQL mutation
- On success, a **Narrative Report** panel appears with the editable generated text

**Report Actions**
- **Save** — saves the report to the user's private `Diagnosis` history in DynamoDB
- **PDF** — renders the report as a styled PDF (with doctor name, date, keywords, report body) and opens it in a new tab

**History Panel** (slide-in overlay)
- Lists all saved diagnoses sorted by newest first
- Click any entry to reload it into the generator
- Trash icon to permanently delete an entry

**Profile Modal** (slide-in overlay)
- Update first name and last name (synced to Cognito `given_name` / `family_name`)
- Change password (requires current password)

---

## Deployment

### AWS Amplify CI/CD

The app is deployed via **AWS Amplify Hosting** connected to the `main` branch of the GitHub repository (`ssegota/vetDemo`).

Every push to `main` triggers:
1. `npm ci` — clean install using `package-lock.json`
2. `npx ampx pipeline-deploy` — CDK synthesis and CloudFormation deployment of the backend
3. `npm run build` — Vite production build
4. Static asset deployment to Amplify's CDN

**App ID:** `dtw1mp72xxclv`  
**Region:** `eu-north-1`

### Environment Notes


- Before running the app amplify_outputs.json must be downloaded from AWS Amplify App (Click on the App -> select the appropriate branch -> Go to "Deployed backend resources" -> Download amplify_outputs.json) and placed into the root directory of the repo.
- The Lambda invokes Bedrock in `us-east-1` (hardcoded in `handler.py`) regardless of the Amplify app region. This is intentional — Bedrock model availability varies by region.
- `amplify_outputs.json` is auto-generated and committed to the repo so the frontend can connect to the correct backend. **Do not edit this file manually.**
- `examples.text` is bundled directly with the Lambda code asset. It contains curated veterinary report examples used as few-shot context for the model. The file is truncated to ~270 KB to stay within Bedrock's token limits.

---

## Known Constraints

### Cognito User Pool Immutability

Amazon Cognito does not allow changing User Pool attributes (e.g. `givenName`, `familyName`) after the pool has been created. If the `auth` configuration in `amplify/auth/resource.ts` needs to change, the following two-step deploy is required:

1. Remove `auth` from `amplify/backend.ts` and temporarily change data auth mode to `apiKey` → push → wait for deploy (this **deletes** the existing User Pool and all its users)
2. Restore `auth` and the original auth modes → push → Amplify recreates a fresh pool

> ⚠️ **Warning:** This process will delete all existing Cognito user accounts.

---

## License

© 2026 Daignostics d.o.o. All rights reserved.

This software is proprietary and confidential. Unauthorised copying, modification, distribution, or use of this software, via any medium, is strictly prohibited.
