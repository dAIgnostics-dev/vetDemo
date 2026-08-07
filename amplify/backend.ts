import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { generateReport } from './functions/generate-report/resource';
import { extractFields } from './functions/extract-fields/resource';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Function } from 'aws-cdk-lib/aws-lambda';

/**
 * @see https://docs.amplify.aws/react/build-a-backend/ to add storage, functions, and more
 */
const backend = defineBackend({
  auth,
  data,
  generateReport,
  extractFields
});

const generateReportFn = backend.generateReport.resources.lambda as Function;

generateReportFn.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['bedrock:InvokeModel'],
    resources: [
      'arn:aws:bedrock:eu-*::foundation-model/*',
      'arn:aws:bedrock:eu-*:*:inference-profile/*'
    ],
  })
);

generateReportFn.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      'aws-marketplace:ViewSubscriptions',
      'aws-marketplace:Subscribe',
      'aws-marketplace:Unsubscribe',
    ],
    resources: ['*'],
  })
);

// Ekstrakcija polja iz diktata — Bedrock pristup, ali samo za ovu Lambdu.
const extractFieldsFn = backend.extractFields.resources.lambda as Function;

extractFieldsFn.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['bedrock:InvokeModel'],
    resources: [
      'arn:aws:bedrock:eu-*::foundation-model/*',
      'arn:aws:bedrock:eu-*:*:inference-profile/*'
    ],
  })
);

const authRole = backend.auth.resources.authenticatedUserIamRole;

// NAPOMENA: browseru se namjerno vise NE daje bedrock:InvokeModel. Prije je svaki
// prijavljeni korisnik mogao zvati bilo koji Bedrock model izravno iz preglednika,
// o trosku ovog racuna. Ekstrakcija sada ide kroz extractFields mutaciju (Lambda).
//
// Transcribe ostaje u pregledniku jer streaming mora ici izravno zbog latencije;
// StartStreamTranscription ne podrzava resource-level dozvole, pa je '*' ocekivan.
authRole.addToPrincipalPolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['transcribe:StartStreamTranscription'],
    resources: ['*'],
  })
);
